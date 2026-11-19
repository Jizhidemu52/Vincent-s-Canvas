import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Cache } from "../../src/db";
import { withTransaction } from "../../src/db-transaction";
import {
  cancelTaskInTransaction, enqueueTask, enqueueTaskInTransaction, lockTaskAdmission,
  prepareTaskEnqueue, publishEnqueuedTask, restoreWaitingTasksToQueue,
  type EnqueuedTaskResult, type PreparedTaskEnqueue, type TaskInput,
} from "../../src/tasks";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const integration = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;

integration("single-connection SQL shared task transactions", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const modelId = randomUUID();
  const queued: string[] = [];
  const cache = { eval: async (_script: string, options: { arguments: string[] }) => {
    queued.push(options.arguments[0]!); return 1;
  } } as unknown as Cache;
  const unavailableCache = { eval: async () => { throw new Error("Isolated cache unavailable"); } } as unknown as Cache;
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    const providerId = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Shared transaction fixture','custom','https://no-network.invalid')", [providerId]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Shared transaction fixture','shared-transaction-fixture',ARRAY['generate'],0,0)", [modelId, providerId]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function context() {
    const userId = randomUUID(), conversationId = randomUUID(), turnId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Shared transaction fixture',100,100,100)", [userId, `shared-${userId}`]);
    await fixture.db.query(`INSERT INTO image_conversations(id,owner_user_id,entrypoint,state_revision,create_request_id,create_request_hash)
      VALUES($1,$2,'standalone',1,$3,$4)`, [conversationId, userId, randomUUID(), "a".repeat(64)]);
    await fixture.db.query(`INSERT INTO image_conversation_turns(id,conversation_id,owner_user_id,client_request_id,payload_hash,input_payload,accepted_revision)
      VALUES($1,$2,$3,$4,$5,$6,1)`, [turnId, conversationId, userId, randomUUID(), "b".repeat(64), { schemaVersion: 1 }]);
    const input: TaskInput = { requestId: `ic:${turnId}:image:1`, userId, departmentId: null, projectId: "",
      operationType: "image_generation", toolKey: "image", modelConfigId: modelId,
      prompt: "Shared transaction fixture", parameters: { size: "1:1", n: 4 }, sourceUrls: [], priority: "normal" };
    return { userId, conversationId, turnId, input };
  }
  type Context = Awaited<ReturnType<typeof context>>;

  async function lockCaller(client: PoolClient, value: Context) {
    await lockTaskAdmission(client, value.userId);
    await client.query("SELECT id FROM image_conversations WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [value.conversationId, value.userId]);
    await client.query("SELECT id FROM image_conversation_turns WHERE id=$1 AND owner_user_id=$2 FOR UPDATE", [value.turnId, value.userId]);
  }

  async function bindTask(client: PoolClient, value: Context, result: EnqueuedTaskResult) {
    await client.query("UPDATE image_conversation_turns SET task_id=$1,task_request_id=$2,state='queued' WHERE id=$3", [result.task.id, result.task.requestId, value.turnId]);
    await client.query("UPDATE image_conversations SET last_event_seq=1 WHERE id=$1", [value.conversationId]);
    await client.query("INSERT INTO image_conversation_events(conversation_id,seq,turn_id,event_type,payload) VALUES($1,1,$2,'task.queued',$3)", [value.conversationId, value.turnId, { taskId: result.task.id }]);
  }

  async function accept(value: Context, prepared: PreparedTaskEnqueue, db = fixture.db) {
    return withTransaction(db, async client => {
      await lockCaller(client, value);
      const result = await enqueueTaskInTransaction(client, prepared);
      await bindTask(client, value, result);
      return result;
    });
  }

  async function assertNoAdmission(value: Context) {
    expect((await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [value.input.requestId])).n).toBe(0);
    expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).n).toBe(0);
    expect((await row("SELECT count(*)::int n FROM credit_ledger WHERE reference_id=$1", [value.input.requestId])).n).toBe(0);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(100);
    expect(await row("SELECT task_id,task_request_id,state FROM image_conversation_turns WHERE id=$1", [value.turnId])).toEqual({ task_id: null, task_request_id: null, state: "accepted" });
    expect((await row("SELECT last_event_seq::int n FROM image_conversations WHERE id=$1", [value.conversationId])).n).toBe(0);
    expect((await row("SELECT count(*)::int n FROM image_conversation_events WHERE conversation_id=$1", [value.conversationId])).n).toBe(0);
  }

  test("preparation only reads, freezes normalized inputs and leaves no task, fee or queue side effect", async () => {
    const value = await context(), offset = fixture.statements.length, queueCount = queued.length;
    const original = structuredClone(value.input);
    const prepared = await prepareTaskEnqueue(fixture.db, value.input);
    expect(fixture.statements.slice(offset).every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(value.input).toEqual(original);
    expect(prepared.input.parameters).toMatchObject({ n: 1, count: 1 });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.input.parameters)).toBe(true);
    value.input.parameters!.size = "16:9";
    expect(prepared.input.parameters!.size).toBe("1:1");
    expect(queued).toHaveLength(queueCount);
    await assertNoAdmission(value);
  });

  for (const [phase, startsWith] of [
    ["task insert", "INSERT INTO tasks"],
    ["credit hold ledger", "INSERT INTO credit_ledger"],
    ["turn binding", "UPDATE image_conversation_turns SET task_id"],
    ["event insert", "INSERT INTO image_conversation_events"],
  ]) test(`failure after ${phase} rolls back task, wallet, hold, binding and event together`, async () => {
    const value = await context(), prepared = await prepareTaskEnqueue(fixture.db, value.input);
    let connections = 0, injected = false;
    const observed = new Proxy(fixture.db, { get(target, property) {
      if (property !== "connect") return Reflect.get(target, property);
      return async () => {
        connections++;
        const client = await target.connect();
        return new Proxy(client, { get(connection, key) {
          if (key !== "query") return Reflect.get(connection, key);
          return async (sql: string, values?: unknown[]) => {
            const result = await connection.query(sql, values);
            if (!injected && sql.trimStart().startsWith(startsWith!)) {
              injected = true; throw new Error(`Injected after ${phase}`);
            }
            return result;
          };
        } });
      };
    } });
    await expect(accept(value, prepared, observed)).rejects.toThrow(`Injected after ${phase}`);
    expect(injected).toBe(true); expect(connections).toBe(1);
    await assertNoAdmission(value);
  });

  test("shared caller locks precede task and fee locks; commit persists all rows before best-effort publication", async () => {
    const value = await context(), prepared = await prepareTaskEnqueue(fixture.db, value.input), offset = fixture.statements.length;
    const queueCount = queued.length;
    const result = await accept(value, prepared);
    const sql = fixture.statements.slice(offset);
    const positions = ["user-inflight-quota", "FROM image_conversations", "FROM image_conversation_turns", "INSERT INTO tasks", "INSERT INTO credit_reservations", "UPDATE image_conversation_turns SET task_id", "INSERT INTO image_conversation_events", "COMMIT"]
      .map(fragment => sql.findIndex(statement => statement.includes(fragment)));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(queued).toHaveLength(queueCount);
    expect(await publishEnqueuedTask(unavailableCache, result)).toEqual({ queuePending: true });
    expect(await row("SELECT task_id,state FROM image_conversation_turns WHERE id=$1", [value.turnId])).toEqual({ task_id: result.task.id, state: "queued" });
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).status).toBe("held");
    expect((await row("SELECT count(*)::int n FROM image_conversation_events WHERE conversation_id=$1", [value.conversationId])).n).toBe(1);
    expect(await publishEnqueuedTask(cache, result)).toEqual({ queuePending: false });
    expect(queued.at(-1)).toBe(result.task.id);
  });

  test("transaction retry reuses one prepared UUID and immutable payload without a second reservation", async () => {
    const value = await context(), prepared = await prepareTaskEnqueue(fixture.db, value.input);
    let callbacks = 0;
    const taskIds: string[] = [];
    const result = await withTransaction(fixture.db, async client => {
      await lockCaller(client, value);
      const result = await enqueueTaskInTransaction(client, prepared);
      taskIds.push(result.task.id);
      await bindTask(client, value, result);
      if (++callbacks === 1) throw Object.assign(new Error("Synthetic serialization retry"), { code: "40001" });
      return result;
    });
    expect(taskIds).toEqual([prepared.taskId, prepared.taskId]);
    expect(result.task.id).toBe(prepared.taskId);
    expect((await row("SELECT count(*)::int n FROM credit_ledger WHERE reference_id=$1 AND entry_type='hold'", [value.input.requestId])).n).toBe(1);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(92);
    expect((await row("SELECT parameters FROM tasks WHERE id=$1", [result.task.id])).parameters).toMatchObject({ n: 1, count: 1, size: "1:1", tool: "image" });
  });

  test("idempotent transaction reads current terminal state and never creates another fee or queue entry", async () => {
    const value = await context(), prepared = await prepareTaskEnqueue(fixture.db, value.input);
    const first = await accept(value, prepared);
    await fixture.db.query("UPDATE tasks SET status='processing' WHERE id=$1", [first.task.id]);
    const repeatPrepared = await prepareTaskEnqueue(fixture.db, { ...value.input, maxInflightTasks: 1 });
    const repeated = await withTransaction(fixture.db, client => enqueueTaskInTransaction(client, repeatPrepared));
    expect(repeated.task).toMatchObject({ id: first.task.id, status: "processing" });
    expect(repeated.shouldQueue).toBe(false);
    expect(await publishEnqueuedTask(unavailableCache, repeated)).toEqual({ queuePending: false });
    expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).n).toBe(1);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(92);
  });

  test("a duplicate committed between preparation reads returns its original task even at capacity", async () => {
    const value = await context(); value.input.maxInflightTasks = 1;
    let created: Awaited<ReturnType<typeof enqueueTask>> | undefined;
    const observed = new Proxy(fixture.db, { get(target, property) {
      if (property !== "query") return Reflect.get(target, property);
      return async (sql: string, values?: unknown[]) => {
        if (!created && sql.startsWith("SELECT count(*)::int AS count FROM tasks")) created = await enqueueTask(fixture.db, cache, value.input);
        return target.query(sql, values);
      };
    } });
    const prepared = await prepareTaskEnqueue(observed, value.input);
    const repeated = await withTransaction(fixture.db, client => enqueueTaskInTransaction(client, prepared));
    expect(repeated.task.id).toBe(created!.id);
    expect((await row("SELECT count(*)::int n FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).n).toBe(1);
  });

  test("legacy enqueue reports committed task with queuePending and restoration republishes that same ID", async () => {
    const value = await context();
    const created = await enqueueTask(fixture.db, unavailableCache, value.input);
    expect(created.queuePending).toBe(true);
    expect((await row("SELECT status FROM tasks WHERE id=$1", [created.id])).status).toBe("waiting");
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).status).toBe("held");
    await restoreWaitingTasksToQueue(fixture.db, cache);
    expect(queued).toContain(created.id);
    const repeated = await enqueueTask(fixture.db, cache, value.input);
    expect(repeated).toMatchObject({ id: created.id, queuePending: false });
    expect((await row("SELECT count(*)::int n FROM tasks WHERE request_id=$1", [value.input.requestId])).n).toBe(1);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(92);
  });

  test("strict cancellation binds owner and rejects processing, all started attempts and unknown submission", async () => {
    const value = await context(), other = await context();
    const created = await enqueueTask(fixture.db, cache, value.input);
    const cancel = (ownerId = value.userId) => withTransaction(fixture.db, client => cancelTaskInTransaction(fixture.db, client, created.id, ownerId));
    expect(await cancel(other.userId)).toBeNull();
    for (const [status, attempts, operation, marker] of [
      ["processing", 0, "image_generation", false], ["waiting", 1, "image_generation", false],
      ["paused", 1, "video_generation", false], ["paused", 0, "image_generation", true],
    ] as const) {
      await fixture.db.query("UPDATE tasks SET status=$2,attempts=$3,operation_type=$4,upstream_submission_started_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1", [created.id, status, attempts, operation, marker]);
      expect(await cancel()).toBeNull();
      expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).status).toBe("held");
    }
    await fixture.db.query("UPDATE tasks SET status='paused',attempts=0,operation_type='image_generation',upstream_submission_started_at=NULL WHERE id=$1", [created.id]);
    expect(await cancel()).toMatchObject({ id: created.id, status: "paused" });
    expect(await cancel()).toBeNull();
    expect((await row("SELECT count(*)::int n FROM credit_ledger WHERE reference_id=$1 AND entry_type='release'", [value.input.requestId])).n).toBe(1);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(100);
  });

  test("caller event failure rolls strict task cancellation and refund back together", async () => {
    const value = await context(), prepared = await prepareTaskEnqueue(fixture.db, value.input);
    const created = await accept(value, prepared);
    await expect(withTransaction(fixture.db, async client => {
      await lockCaller(client, value);
      expect(await cancelTaskInTransaction(fixture.db, client, created.task.id, value.userId)).not.toBeNull();
      await client.query("UPDATE image_conversation_turns SET state='cancelled',auto_activate=false WHERE id=$1", [value.turnId]);
      await client.query("INSERT INTO image_conversation_events(conversation_id,seq,turn_id,event_type,payload) VALUES($1,2,$2,'turn.cancelled',$3)", [value.conversationId, value.turnId, {}]);
      throw new Error("Caller event failure");
    })).rejects.toThrow("Caller event failure");
    expect((await row("SELECT status FROM tasks WHERE id=$1", [created.task.id])).status).toBe("waiting");
    expect((await row("SELECT status FROM credit_reservations WHERE request_id=$1", [value.input.requestId])).status).toBe("held");
    expect((await row("SELECT state FROM image_conversation_turns WHERE id=$1", [value.turnId])).state).toBe("queued");
    expect((await row("SELECT count(*)::int n FROM image_conversation_events WHERE conversation_id=$1", [value.conversationId])).n).toBe(1);
    expect((await row("SELECT credit_balance FROM users WHERE id=$1", [value.userId])).credit_balance).toBe(92);
    expect((await row("SELECT count(*)::int n FROM credit_ledger WHERE reference_id=$1 AND entry_type='release'", [value.input.requestId])).n).toBe(0);
  });
});
