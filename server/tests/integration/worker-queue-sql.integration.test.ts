import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { settleReservation } from "../../src/billing";
import { withTransaction } from "../../src/db-transaction";
import { acquireModelLease, releaseModelLease, renewTaskLease, startTaskLeaseHeartbeat, TaskExecutionLost } from "../../src/model-concurrency";
import { popReadyTask, removeQueuedTask, scheduleQueuedTask } from "../../src/task-queue";
import { canAutomaticallyRetryTask, queueScore, recalculateBatch, restoreWaitingTasksToQueue, TASK_LEASE_SECONDS, transitionTask } from "../../src/tasks";
import { stepApiMartVideoTask, VideoProviderFailure, VideoSubmissionClaimLost, VideoTaskPending, type ApiMartVideoInput } from "../../src/media-runtime";
import { ApiMartImageProviderFailure, ApiMartImageTaskPending, stepApiMartImageTask, type ApiMartImageTaskInput } from "../../src/apimart-image";
import { ProviderSubmissionRejected, submissionWasNotSent } from "../../src/provider-submission-policy";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { createIsolatedQueueCache } from "../helpers/isolated-queue-cache";
import { disposeProviderResults, downloadVideoResult } from "../../src/media-result-file";
import { WorkflowTaskPending } from "../../src/workflow-task-context";

const integration = process.env.PGLITE_RUNTIME_PATH && process.env.QUEUE_TEST_REDIS_URL ? test : test.skip;
const redisTest = process.env.QUEUE_TEST_REDIS_URL ? test : test.skip;

redisTest("delayed tasks cannot pop before due time; ready priority and atomic promotion are retained", async () => {
  const fixture = await createIsolatedQueueCache();
  try {
    await scheduleQueuedTask(fixture.cache, "future-urgent", queueScore("urgent", 2_000), 2_000, 1_000);
    await scheduleQueuedTask(fixture.cache, "ready-normal", queueScore("normal", 1_000), 1_000, 1_000);
    await scheduleQueuedTask(fixture.cache, "cancelled", queueScore("urgent", 1_500), 1_500, 1_000);
    await removeQueuedTask(fixture.cache, "cancelled");
    expect(await popReadyTask(fixture.cache, 1_000)).toBe("ready-normal");
    expect(await popReadyTask(fixture.cache, 1_999)).toBeNull();
    expect(await fixture.zCard("tasks:delayed")).toBe(1);
    const claims = await Promise.all(Array.from({ length: 10 }, () => popReadyTask(fixture.cache, 2_000)));
    expect(claims.filter(Boolean)).toEqual(["future-urgent"]);
    expect(await fixture.zCard("tasks:delayed")).toBe(0);
  } finally { await fixture.close(); }
});

async function databaseFixture(kind: "image" | "video" = "video") {
  const sql = await createIsolatedPostgres();
  const redis = await createIsolatedQueueCache();
  const user = randomUUID(), provider = randomUUID(), model = randomUUID();
  await sql.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Queue fixture','designer')", [user, `queue-${user}`]);
  await sql.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Queue fixture','apimart','https://provider.invalid/v1')", [provider]);
  await sql.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,concurrency_limit) VALUES($1,$2,'Queue fixture',$3,3)", [model, provider, kind === "image" ? "gpt-image-2.5-flare" : "wan2.7"]);
  async function task() {
    const id = randomUUID();
    await sql.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt) VALUES($1,$2,$3,'queue-fixture',$6,$4,$5)", [id, `request-${id}`, user, model, `task-${id}`, `${kind}_generation`]);
    await sql.db.query("INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,rmb_cost,price_snapshot,status) VALUES($1,$2,$3,1,0,0,'{\"billingDisabled\":true}','held')", [`request-${id}`, user, `${kind}_generation`]);
    return id;
  }
  return { ...sql, redis, model, task, close: async () => { await redis.close(); await sql.close(); } };
}

async function productionWorker(dependencies: Record<string, unknown>) {
  dependencies = { disposeProviderResults, WorkflowTaskPending, ...dependencies };
  // Exercise the real orchestration/provider functions without importing the
  // worker entrypoint (which intentionally starts configured production services).
  const file = await Bun.file(new URL("../../src/worker.ts", import.meta.url)).text();
  const source = ts.createSourceFile("worker.ts", file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = ["runTask", "deferTask", "assertTaskExecution", "executeApiMartVideo", "executeApiMartImage"];
  const code = names.map(name => {
    const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`);
    return node.getText(source);
  }).join("\n");
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(dependencies), `${js};
    async function executeProvider(task) { return task.operation_type === 'image_generation'
      ? executeApiMartImage(task,{apiKey:'fixture-only'}) : executeApiMartVideo(task,{apiKey:'fixture-only'}); }
    return {runTask};`)(...Object.values(dependencies)) as { runTask(id: string): Promise<void> };
}

for (const kind of ["video", "image"] as const) integration(`30 mock ${kind}s release worker slots, preserve model inflight quota and recover without a second POST`, async () => {
  const fixture = await databaseFixture(kind);
  const { db, redis, model } = fixture;
  const submitted = new Map<string, { polls: number; complete: boolean }>();
  let inflight = 0, maxInflight = 0, posts = 0, referenceLoads = 0;
  const fakeFetch = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const prompt = JSON.parse(String(init.body)).prompt as string;
      expect(submitted.has(prompt)).toBe(false);
      submitted.set(prompt, { polls: 0, complete: false });
      posts++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      return Response.json({ data: [{ task_id: prompt }] });
    }
    if (url.includes("/tasks/")) {
      const id = decodeURIComponent(url.split("/tasks/")[1]!);
      const remote = submitted.get(id)!;
      if (++remote.polls < 2) return Response.json({ data: { status: "processing" } });
      if (!remote.complete) { remote.complete = true; inflight--; }
      const result = kind === "image" ? { images: [{ url: `https://provider.invalid/files/${id}.png` }] }
        : { videos: [`https://provider.invalid/files/${id}.mp4`] };
      return Response.json({ data: { status: "completed", result } });
    }
    if (url.includes("/files/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`Unexpected offline fixture request ${url}`);
  };
  const worker = await productionWorker({
    db, cache: redis.cache, randomUUID, TASK_LEASE_SECONDS, config: { TASK_MOCK_MODE: "false" },
    acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost,
    withTransaction, settleReservation, scheduleQueuedTask, queueScore, canAutomaticallyRetryTask, recalculateBatch,
    VideoTaskPending, ApiMartImageTaskPending, VideoSubmissionClaimLost, VideoProviderFailure, ApiMartImageProviderFailure,
    ProviderSubmissionRejected, submissionWasNotSent,
    createGenerationTiming: () => ({ measure: async (_stage: string, action: () => unknown) => action(), finish() {} }),
    readProviderSubmissionDiagnostics: () => undefined,
    storage: { configured: true }, loadSourceAssets: async () => { referenceLoads++; return []; }, loadVideoSourceAssets: async () => { referenceLoads++; return []; },
    downloadVideoResult: (url: string) => downloadVideoResult(url, fakeFetch),
    stepApiMartVideoTask: (input: ApiMartVideoInput) => stepApiMartVideoTask(input, { fetch: fakeFetch }),
    stepApiMartImageTask: (input: ApiMartImageTaskInput) => stepApiMartImageTask(input, { fetch: fakeFetch }),
    fetchProviderResult: async (url: string) => {
      expect(url).toStartWith("https://provider.invalid/files/");
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
    },
    fetch: fakeFetch,
    storeResults: async (task: { id: string }) => [`/api/assets/${task.id}/content`],
  });
  async function drainReady() {
    for (let wave = 0; wave < 20; wave++) {
      const ids = await Promise.all(Array.from({ length: 10 }, () => popReadyTask(redis.cache)));
      if (ids.every(id => !id)) return;
      await Promise.all(ids.filter((id): id is string => Boolean(id)).map(id => worker.runTask(id)));
    }
    throw new Error("Queue is spinning rather than deferring blocked tasks");
  }
  try {
    for (let n = 0; n < 30; n++) await fixture.task();
    await restoreWaitingTasksToQueue(db, redis.cache);
    await drainReady();
    expect(posts).toBe(3);
    expect(inflight).toBe(3);
    expect([...submitted.values()].every(remote => remote.polls === 0)).toBe(true);
    expect(await popReadyTask(redis.cache)).toBeNull();
    expect((await db.query("SELECT sum(attempts)::int AS attempts FROM tasks")).rows[0].attempts).toBe(3);
    expect((await db.query("SELECT count(*)::int AS count FROM tasks WHERE status='processing' AND execution_token IS NULL")).rows[0].count).toBe(3);
    expect((await db.query("SELECT count(*)::int AS count FROM tasks WHERE status='processing' AND lease_expires_at IS NULL AND model_slot_token IS NOT NULL AND poll_deadline_at>now()")).rows[0].count).toBe(3);
    const deadlines = (await db.query("SELECT id,poll_deadline_at FROM tasks WHERE status='processing' ORDER BY id")).rows;

    // Simulate process interruption plus total loss of this fixture's Redis keys.
    // Inflight upstream jobs continue; no new job may evade their durable slots.
    await redis.clear();
    await db.query("UPDATE tasks SET execution_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',model_slot_expires_at=now()-interval '1 second' WHERE status='processing'");
    await restoreWaitingTasksToQueue(db, redis.cache);
    expect((await db.query("SELECT count(*)::int AS count FROM tasks WHERE status='processing' AND execution_token IS NULL")).rows[0].count).toBe(3);
    expect((await db.query("SELECT id,poll_deadline_at FROM tasks WHERE status='processing' ORDER BY id")).rows).toEqual(deadlines);

    for (let round = 0; round < 30; round++) {
      // Advance the durable test deadlines without waiting 2 seconds per poll.
      // The preceding independent Redis test verifies the actual due gate.
      await db.query("UPDATE tasks SET available_at=now()-interval '1 millisecond' WHERE status IN ('waiting','processing') AND execution_token IS NULL");
      await restoreWaitingTasksToQueue(db, redis.cache);
      await drainReady();
      if ((await db.query("SELECT count(*)::int AS count FROM tasks WHERE status='success'")).rows[0].count === 30) break;
    }
    expect(maxInflight).toBe(3);
    expect(posts).toBe(30);
    expect(referenceLoads).toBe(30);
    expect(inflight).toBe(0);
    expect((await db.query("SELECT status,count(*)::int AS count,min(attempts)::int AS minimum,max(attempts)::int AS maximum FROM tasks GROUP BY status")).rows).toEqual([{ status: "success", count: 30, minimum: 1, maximum: 1 }]);
    expect((await db.query("SELECT count(*)::int AS count FROM credit_reservations WHERE status='captured'")).rows[0].count).toBe(30);
    expect((await db.query("SELECT count(*)::int AS count FROM generation_history")).rows[0].count).toBe(30);
    expect((await db.query("SELECT count(*)::int AS count FROM tasks WHERE model_slot_token IS NOT NULL OR execution_token IS NOT NULL")).rows[0].count).toBe(0);
    expect(await redis.zCard(`model:${model}:leases`)).toBe(0);
  } finally { await fixture.close(); }
}, 120_000);

for (const [kind, minutes] of [["image", 15], ["video", 20]] as const) integration(`resuming an expired ${kind} gives ${minutes} minutes and only requeues the original held task`, async () => {
  const fixture = await databaseFixture(kind);
  const { db, redis } = fixture;
  const requests: Array<{ method: string; url: string }> = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method || "GET", url });
    expect(init?.method).toBe("GET");
    expect(url).toBe("https://provider.invalid/v1/tasks/original-upstream");
    return Response.json({ data: { status: "processing" } });
  };
  const worker = await productionWorker({
    db, cache: redis.cache, randomUUID, TASK_LEASE_SECONDS, config: { TASK_MOCK_MODE: "false" },
    acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost,
    withTransaction, settleReservation, scheduleQueuedTask, queueScore, canAutomaticallyRetryTask, recalculateBatch,
    VideoTaskPending, ApiMartImageTaskPending, VideoSubmissionClaimLost, VideoProviderFailure, ApiMartImageProviderFailure,
    ProviderSubmissionRejected, submissionWasNotSent,
    createGenerationTiming: () => ({ measure: async (_stage: string, action: () => unknown) => action(), finish() {} }),
    readProviderSubmissionDiagnostics: () => undefined,
    storage: { configured: true }, loadSourceAssets: async () => { throw new Error("Recovery cannot reload references"); }, loadVideoSourceAssets: async () => { throw new Error("Recovery cannot reload references"); },
    stepApiMartVideoTask: (input: ApiMartVideoInput) => stepApiMartVideoTask(input, { fetch: fakeFetch }),
    stepApiMartImageTask: (input: ApiMartImageTaskInput) => stepApiMartImageTask(input, { fetch: fakeFetch }),
  });
  try {
    const id = await fixture.task();
    await db.query(`UPDATE tasks SET status='paused',attempts=1,upstream_task_id='original-upstream',
      upstream_submission_started_at=now()-interval '30 minutes',poll_deadline_at=now()-interval '1 minute',
      model_slot_token=gen_random_uuid(),model_slot_expires_at=now()-interval '1 second',
      execution_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second' WHERE id=$1`, [id]);
    const identity = () => db.query("SELECT upstream_task_id,upstream_submission_started_at,attempts,model_slot_token,queued_at FROM tasks WHERE id=$1", [id]);
    const reservation = () => db.query("SELECT * FROM credit_reservations WHERE request_id=$1", [`request-${id}`]);
    const original = (await identity()).rows[0], held = (await reservation()).rows[0];
    expect(held.status).toBe("held");
    const before = (await db.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS clock_ms")).rows[0].clock_ms;

    expect(await transitionTask(db, redis.cache, id, "resume")).toEqual({ id, batchId: null, previousStatus: "paused", action: "resume" });
    const after = (await db.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 AS clock_ms")).rows[0].clock_ms;
    const resumed = (await db.query("SELECT status,execution_token,lease_expires_at,poll_deadline_at,available_at<=now() AS ready FROM tasks WHERE id=$1", [id])).rows[0];
    const deadline = new Date(resumed.poll_deadline_at).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + minutes * 60_000);
    expect(deadline).toBeLessThanOrEqual(after + minutes * 60_000);
    expect(resumed).toMatchObject({ status: "waiting", execution_token: null, lease_expires_at: null, ready: true });
    expect((await identity()).rows[0]).toEqual(original);
    expect((await reservation()).rows[0]).toEqual(held);
    expect(requests).toEqual([]);
    expect(await redis.zCard("tasks:queue")).toBe(1);
    expect(await redis.zCard("tasks:delayed")).toBe(0);
    expect(await transitionTask(db, redis.cache, id, "resume")).toBeNull();
    expect(await redis.zCard("tasks:queue")).toBe(1);

    // Dispatch the resumed task through the real worker orchestration as well:
    // a fresh execution may only GET the original ID, then yield again.
    expect(await popReadyTask(redis.cache)).toBe(id);
    await worker.runTask(id);
    expect(requests).toEqual([{ method: "GET", url: "https://provider.invalid/v1/tasks/original-upstream" }]);
    expect((await identity()).rows[0]).toEqual(original);
    expect((await reservation()).rows[0]).toEqual(held);
    const deferred = (await db.query("SELECT status,execution_token,lease_expires_at,poll_deadline_at FROM tasks WHERE id=$1", [id])).rows[0];
    expect(deferred).toMatchObject({ status: "processing", execution_token: null, lease_expires_at: null });
    expect(new Date(deferred.poll_deadline_at).getTime()).toBe(deadline);
    expect(await redis.zCard("tasks:delayed")).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM credit_ledger")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM generation_history")).rows[0].count).toBe(0);
  } finally { await fixture.close(); }
}, 60_000);

integration("renewal is fenced; stale owners cannot clear a successor's model slot and unknown submissions remain paused", async () => {
  const fixture = await databaseFixture();
  const { db, redis, model } = fixture;
  try {
    const id = await fixture.task(), first = randomUUID(), second = randomUUID();
    await db.query("UPDATE tasks SET status='processing',execution_token=$1,lease_expires_at=now()+interval '3 minutes' WHERE id=$2", [first, id]);
    const lease = (await acquireModelLease(db, redis.cache, { taskId: id, executionToken: first, modelConfigId: model, limit: 1 }))!;
    await renewTaskLease(db, redis.cache, lease, 180);
    expect((await db.query("SELECT model_slot_expires_at>now() AS live FROM tasks WHERE id=$1", [id])).rows[0].live).toBe(true);
    await db.query("UPDATE tasks SET execution_token=$1 WHERE id=$2", [second, id]);
    await expect(renewTaskLease(db, redis.cache, lease, 180)).rejects.toBeInstanceOf(TaskExecutionLost);
    await releaseModelLease(db, redis.cache, lease);
    expect((await db.query("SELECT model_slot_token FROM tasks WHERE id=$1", [id])).rows[0].model_slot_token).toBe(lease.slotToken);
    await db.query("UPDATE tasks SET upstream_submission_started_at=now(),lease_expires_at=now()-interval '1 second',attempts=1 WHERE id=$1", [id]);
    await restoreWaitingTasksToQueue(db, redis.cache);
    expect((await db.query("SELECT status,upstream_task_id,model_slot_token FROM tasks WHERE id=$1", [id])).rows[0]).toEqual({ status: "paused", upstream_task_id: null, model_slot_token: lease.slotToken });
    expect(await popReadyTask(redis.cache)).toBeNull();
  } finally { await fixture.close(); }
}, 60_000);
