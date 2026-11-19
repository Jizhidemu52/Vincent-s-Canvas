import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import type { ContextManifest, GenerateNewPlan, SettingsSnapshot } from "../../../shared/image-conversation-contracts";
import { cancelImageConversationTurn, createImageConversation, submitImageConversationTurn } from "../../src/image-conversation-service";
import { processImageConversationTurn, type ImageConversationWorkerDependencies } from "../../src/image-conversation-worker";
import { lockTaskAdmission, prepareTaskEnqueue } from "../../src/tasks";
import { conversationDatabaseMode, createConversationPostgres } from "../helpers/conversation-postgres";

const integration = conversationDatabaseMode() === "postgres" ? describe : describe.skip;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function checkpoint<T>(ready: Promise<T>, operation: Promise<unknown>) {
  return Promise.race([ready, operation.then(() => { throw new Error("Native concurrency operation ended before reaching its lock checkpoint"); })]);
}
const generation: GenerateNewPlan = { action: "generate_new", assistantText: "生成一件针织衫。", description: "纯色针织衫",
  requestedState: { schemaVersion: 1, goals: ["纯色针织衫"], constraints: [] }, references: [], outputIntent: { purpose: "standard", complexity: "medium" } };
const manifest: ContextManifest = { schemaVersion: 1, summaryThroughSeq: 0, messageSeqs: [1], inputActiveVersionId: null,
  baseVersionId: null, sourceStateVersionId: null, images: [], attachments: [], omittedHistory: false, policyVersion: "pg17-lock-test" };

integration("PostgreSQL 17 native multi-connection conversation locking", () => {
  let fixture: Awaited<ReturnType<typeof createConversationPostgres>>;
  const modelId = randomUUID();
  beforeAll(async () => {
    fixture = await createConversationPostgres();
    expect(fixture.backend).toBe("postgres");
    const provider = randomUUID();
    await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Native PG lock fixture','custom','https://never-called.invalid')", [provider]);
    await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost) VALUES($1,$2,'Native PG lock fixture','gpt-image-2.6-flare',ARRAY['generate','edit'],7,0)", [modelId, provider]);
    await fixture.db.query("UPDATE tool_api_configurations SET model_config_id=$1,enabled=true,credit_cost_override=7,rmb_cost_override=0 WHERE tool_key='image'", [modelId]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  const row = async (sql: string, values: unknown[] = []) => (await fixture.db.query(sql, values)).rows[0];

  async function context() {
    const ownerId = randomUUID();
    await fixture.db.query("INSERT INTO users(id,username,display_name,credit_balance,credit_limit,monthly_credit_limit) VALUES($1,$2,'Native lock fixture',100,100,100)", [ownerId, `native-lock-${ownerId}`]);
    const conversation = (await createImageConversation(fixture.db, ownerId, { clientRequestId: randomUUID(), entrypoint: "standalone" })).snapshot;
    return { ownerId, conversationId: conversation.id };
  }
  async function accepted() {
    const current = await context();
    const turn = await submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, { clientRequestId: randomUUID(), expectedStateRevision: 0, text: "生成一件纯色针织衫" });
    return { ...current, turnId: turn.result.turnId };
  }
  async function waitForBlockedConnections(holderPid: number, count: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blocked = await fixture.db.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND application_name=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))`, [fixture.schema, holderPid]);
      if (blocked.rows.length >= count) {
        expect(new Set(blocked.rows.map(item => item.pid)).size).toBe(count);
        expect(blocked.rows.every(item => item.pid !== holderPid)).toBe(true);
        return;
      }
      await Bun.sleep(10);
    }
    throw new Error(`Expected ${count} independent PostgreSQL sessions waiting on the held admission lock`);
  }
  async function concurrentAdmission<T>(ownerId: string, operations: Array<() => Promise<T>>) {
    const blocker = await fixture.db.connect();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await lockTaskAdmission(blocker, ownerId);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = Promise.allSettled(operations.map(operation => operation()));
      await waitForBlockedConnections(pid, operations.length);
      await blocker.query("COMMIT");
      return await pending;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await pending;
    }
  }

  test("two native sessions submitting different requests admit exactly one active turn", async () => {
    const current = await context();
    const results = await concurrentAdmission(current.ownerId, Array.from({ length: 2 }, () => () => submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId,
      { clientRequestId: randomUUID(), expectedStateRevision: 0, text: "并发独立需求" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(result => result.status === "rejected");
    expect(rejected).toHaveLength(1); expect(rejected[0]!.reason).toMatchObject({ code: "CONVERSATION_REVISION_CONFLICT" });
    expect(await row("SELECT count(*)::int n FROM image_conversation_turns WHERE conversation_id=$1", [current.conversationId])).toEqual({ n: 1 });
    expect(await row("SELECT state_revision::int revision FROM image_conversations WHERE id=$1", [current.conversationId])).toEqual({ revision: 1 });
    expect(await row("SELECT count(*)::int n FROM image_conversation_messages WHERE conversation_id=$1 AND role='user'", [current.conversationId])).toEqual({ n: 1 });
  }, 20_000);

  test("two native sessions with the same request return one durable turn and one replay", async () => {
    const current = await context(), request = { clientRequestId: randomUUID(), expectedStateRevision: 0, text: "同一并发请求" };
    const results = await concurrentAdmission(current.ownerId, Array.from({ length: 2 }, () => () => submitImageConversationTurn(fixture.db, current.ownerId, current.conversationId, request)));
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const replies = results.filter(result => result.status === "fulfilled").map(result => result.value);
    expect(replies.map(reply => reply.replayed).sort()).toEqual([false, true]);
    expect(new Set(replies.map(reply => reply.result.turnId)).size).toBe(1);
    expect(await row("SELECT count(*)::int n FROM image_conversation_turns WHERE conversation_id=$1", [current.conversationId])).toEqual({ n: 1 });
    expect(await row("SELECT count(*)::int n FROM image_conversation_events WHERE conversation_id=$1 AND event_type='turn.accepted'", [current.conversationId])).toEqual({ n: 1 });
    expect(await row("SELECT count(*)::int n FROM image_conversation_messages WHERE conversation_id=$1 AND role='user'", [current.conversationId])).toEqual({ n: 1 });
  }, 20_000);

  function settings(): SettingsSnapshot {
    return { policyVersion: "pg17-lock-test", requested: { mode: "auto" }, intent: { purpose: "standard", complexity: "medium", sizeMode: "provider_auto" },
      effective: { modelConfigId: modelId, model: "gpt-image-2.6-flare", n: 1, quality: "high", resolution: "2k", size: "auto", complexity: "medium", output_format: "png" },
      resolutionApplied: true, sourceMap: { model: "admin_binding", n: "policy", quality: "policy", resolution: "policy", complexity: "policy", output_format: "policy", size: "policy" },
      estimate: { internalCredits: 7, internalRmb: "0", providerEstimatedRmb: null, providerActualRmb: null, priceSource: "fixture", priceVersion: "1", reservationQuality: "high" }, actual: null };
  }
  function dependencies(): ImageConversationWorkerDependencies {
    return {
      preparePlanner: async () => ({ manifest, run: async () => generation }),
      prepareImage: async execution => ({ manifest, settings: settings(), validate: async () => {}, task: await prepareTaskEnqueue(fixture.db, {
        requestId: `ic:${execution.turn.id}:image:1`, userId: execution.conversation.owner_user_id, departmentId: null, projectId: "", operationType: "image_generation",
        toolKey: "image", modelConfigId: modelId, prompt: "Native database fixture only", sourceUrls: [], parameters: { n: 1 }, priority: "normal", creditsEnabled: true,
      }) }),
      resolveRestore: async () => { throw new Error("Unexpected restore"); }, publishTask: async () => {}, wake: () => {},
    };
  }

  test("queue commits under the native admission lock before blocked cancellation releases exactly one hold", async () => {
    const current = await accepted(), hooks = dependencies(), locked = deferred<number>(), release = deferred<void>();
    const prepare = hooks.prepareImage;
    hooks.prepareImage = async execution => {
      const image = await prepare(execution);
      if ("clarification" in image) throw new Error("Unexpected clarification");
      image.validate = async client => { locked.resolve((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid); await release.promise; };
      return image;
    };
    const worker = processImageConversationTurn(fixture.db, current.turnId, hooks);
    let cancellation: ReturnType<typeof cancelImageConversationTurn> | undefined;
    try {
      const workerPid = await checkpoint(locked.promise, worker);
      cancellation = cancelImageConversationTurn(fixture.db, current.ownerId, current.conversationId, current.turnId, { expectedStateRevision: 1 });
      await waitForBlockedConnections(workerPid, 1);
      release.resolve();
      expect(await worker).toBe(true);
      expect(await cancellation).toMatchObject({ state: "cancelled", disposition: "cancelled_before_submission" });
      expect(await row("SELECT state,auto_activate FROM image_conversation_turns WHERE id=$1", [current.turnId])).toEqual({ state: "cancelled", auto_activate: false });
      expect(await row("SELECT status FROM tasks WHERE request_id=$1", [`ic:${current.turnId}:image:1`])).toEqual({ status: "cancelled" });
      expect(await row("SELECT status,credits FROM credit_reservations WHERE request_id=$1", [`ic:${current.turnId}:image:1`])).toEqual({ status: "released", credits: 7 });
      expect(await row("SELECT credit_balance FROM users WHERE id=$1", [current.ownerId])).toEqual({ credit_balance: 100 });
      expect((await fixture.db.query("SELECT entry_type FROM credit_ledger WHERE user_id=$1 ORDER BY created_at", [current.ownerId])).rows.map(item => item.entry_type)).toEqual(["hold", "release"]);
    } finally {
      release.resolve();
      await Promise.allSettled([worker, ...(cancellation ? [cancellation] : [])]);
    }
  }, 20_000);

  test("cancellation holding the native admission lock fences a concurrent queue transaction before any task or fee exists", async () => {
    const current = await accepted(), hooks = dependencies(), prepared = deferred<void>(), queue = deferred<void>(), locked = deferred<number>(), release = deferred<void>();
    const prepare = hooks.prepareImage;
    hooks.prepareImage = async execution => { const image = await prepare(execution); prepared.resolve(); await queue.promise; return image; };
    let paused = false;
    const cancellingDb = new Proxy(fixture.db, { get(target, key) {
      if (key !== "connect") return Reflect.get(target, key);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, property) {
          if (property !== "query") return Reflect.get(connection, property);
          return async (sql: string, values?: unknown[]) => {
            const result = await connection.query(sql, values);
            if (!paused && sql.startsWith("SELECT pg_advisory_xact_lock")) {
              paused = true;
              locked.resolve((await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
              await release.promise;
            }
            return result;
          };
        } });
      };
    } }) as Database;
    const worker = processImageConversationTurn(fixture.db, current.turnId, hooks);
    let cancellation: ReturnType<typeof cancelImageConversationTurn> | undefined;
    try {
      await checkpoint(prepared.promise, worker);
      cancellation = cancelImageConversationTurn(cancellingDb, current.ownerId, current.conversationId, current.turnId, { expectedStateRevision: 1 });
      const cancellationPid = await checkpoint(locked.promise, cancellation);
      queue.resolve();
      await waitForBlockedConnections(cancellationPid, 1);
      release.resolve();
      expect(await cancellation).toMatchObject({ state: "cancelled", disposition: "cancelled_before_submission" });
      await worker;
      expect(await row("SELECT state,task_id,auto_activate FROM image_conversation_turns WHERE id=$1", [current.turnId])).toEqual({ state: "cancelled", task_id: null, auto_activate: false });
      for (const table of ["tasks", "credit_reservations"]) expect(await row(`SELECT count(*)::int n FROM ${table} WHERE request_id=$1`, [`ic:${current.turnId}:image:1`])).toEqual({ n: 0 });
      expect(await row("SELECT credit_balance FROM users WHERE id=$1", [current.ownerId])).toEqual({ credit_balance: 100 });
      expect(await row("SELECT count(*)::int n FROM credit_ledger WHERE user_id=$1", [current.ownerId])).toEqual({ n: 0 });
    } finally {
      queue.resolve(); release.resolve();
      await Promise.allSettled([worker, ...(cancellation ? [cancellation] : [])]);
    }
  }, 20_000);
});
