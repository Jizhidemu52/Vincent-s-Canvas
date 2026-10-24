import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { settleReservation } from "../../src/billing";
import { withTransaction } from "../../src/db-transaction";
import { acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost } from "../../src/model-concurrency";
import { popReadyTask, scheduleQueuedTask } from "../../src/task-queue";
import { canAutomaticallyRetryTask, queueScore, recalculateBatch, restoreWaitingTasksToQueue, TASK_LEASE_SECONDS, transitionTask } from "../../src/tasks";
import { VideoProviderFailure, VideoSubmissionClaimLost, VideoTaskPending } from "../../src/media-runtime";
import { ApiMartImageProviderFailure, ApiMartImageTaskPending } from "../../src/apimart-image";
import { ProviderSubmissionRejected, isDefinitiveSubmissionRejection, submissionWasNotSent } from "../../src/provider-submission-policy";
import { disposeProviderResults } from "../../src/media-result-file";
import { normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate } from "../../src/workflow-runtime";
import { assertWorkflowTaskContext, workflowTaskContext, WorkflowTaskPending } from "../../src/workflow-task-context";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { createIsolatedQueueCache } from "../helpers/isolated-queue-cache";

const integration = process.env.PGLITE_RUNTIME_PATH && process.env.QUEUE_TEST_REDIS_URL ? test : test.skip;

async function fixture(providerFetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const sql = await createIsolatedPostgres();
  const redis = await createIsolatedQueueCache();
  try {
  const user = randomUUID(), provider = randomUUID(), model = randomUUID(), workflow = randomUUID();
  await sql.db.query("INSERT INTO users(id,username,display_name,role) VALUES($1,$2,'Workflow fixture','designer')", [user, `workflow-${user}`]);
  await sql.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Workflow fixture','custom','https://workflow.invalid','fixture-only')", [provider]);
  await sql.db.query(`INSERT INTO workflow_configs(id,provider_id,name,protocol,capability,submit_path,status_path,request_template,external_task_path,status_value_path,success_values,failure_values,output_path,poll_interval_ms,timeout_seconds)
    VALUES($1,$2,'Workflow fixture','custom','generate','/submit','/status/{taskId}','{"n":1,"prompt":"$prompt","id":"$taskId"}','job.id','state',ARRAY['DONE'],ARRAY['FAILED'],'outputs',500,37)`, [workflow, provider]);
  await sql.db.query("INSERT INTO model_configs(id,provider_id,workflow_config_id,name,model_id,concurrency_limit) VALUES($1,$2,$3,'Workflow fixture','fixture-model',2)", [model, provider, workflow]);
  const names = ["runTask", "deferTask", "assertTaskExecution", "claimProviderSubmission", "assertProviderSubmissionResponse", "executeProvider", "executeWorkflow", "isImageWorkflowTask", "isBuiltinSingleImageWorkflow", "singleImageWorkflowRequestBody"];
  const source = ts.createSourceFile("worker.ts", await Bun.file(new URL("../../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true);
  const code = ts.transpileModule(names.map(name => {
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing function ${name}`);
    return node.getText(source);
  }).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let sourceLoads = 0, stored = 0;
  const dependencies = { db: sql.db, cache: redis.cache, randomUUID, TASK_LEASE_SECONDS, config: { TASK_MOCK_MODE: "false", PROVIDER_ENCRYPTION_KEY: "fixture" },
    acquireModelLease, releaseModelLease, startTaskLeaseHeartbeat, TaskExecutionLost, withTransaction, settleReservation,
    scheduleQueuedTask, queueScore, canAutomaticallyRetryTask, recalculateBatch, VideoTaskPending, ApiMartImageTaskPending, WorkflowTaskPending,
    VideoSubmissionClaimLost, VideoProviderFailure, ApiMartImageProviderFailure, ProviderSubmissionRejected, isDefinitiveSubmissionRejection, submissionWasNotSent,
    createGenerationTiming: () => ({ measure: async (_stage: string, action: () => unknown) => action(), finish() {} }),
    readProviderSubmissionDiagnostics: () => undefined, disposeProviderResults, decryptSecret: () => '{"apiKey":"fixture-only"}',
    assertImageEditMaskSupport: () => {}, assertWorkflowTaskContext, workflowTaskContext,
    normalizeWorkflowOutputs, parsePromptVariables, readPath, renderTemplate,
    loadSourceAssets: async () => { sourceLoads++; return []; },
    fetch: providerFetch, fetchProviderResult: async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" }),
    joinUrl: (base: string, path: string) => base + path,
    storeResults: async (task: { id: string }) => { stored++; return [`/api/assets/${task.id}/content`]; },
  };
  const worker = new Function(...Object.keys(dependencies), `${code};return {runTask}`)(...Object.values(dependencies)) as { runTask(id: string): Promise<void> };
  const task = async () => {
    const id = randomUUID();
    await sql.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt) VALUES($1,$2,$3,'workflow-fixture','image_generation',$4,'shirt')", [id, `workflow-${id}`, user, model]);
    await sql.db.query(`INSERT INTO credit_reservations(request_id,user_id,operation_type,quantity,credits,rmb_cost,price_snapshot,status)
      VALUES($1,$2,'image_generation',1,0,0,'{"billingDisabled":true}','held')`, [`workflow-${id}`, user]);
    return id;
  };
  const row = async (id: string) => (await sql.db.query("SELECT * FROM tasks WHERE id=$1", [id])).rows[0];
  const reservation = async (id: string) => (await sql.db.query("SELECT * FROM credit_reservations WHERE request_id=$1", [`workflow-${id}`])).rows[0];
  const ready = async () => { await sql.db.query("UPDATE tasks SET available_at=now()-interval '1 millisecond' WHERE status IN ('waiting','processing') AND execution_token IS NULL"); await restoreWaitingTasksToQueue(sql.db, redis.cache); };
  const drain = async () => {
    for (let n = 0; n < 20; n++) {
      const ids = (await Promise.all([popReadyTask(redis.cache), popReadyTask(redis.cache), popReadyTask(redis.cache)])).filter((id): id is string => Boolean(id));
      if (!ids.length) return;
      await Promise.all(ids.map(id => worker.runTask(id)));
    }
    throw new Error("Workflow queue did not defer");
  };
  return { ...sql, redis, provider, model, workflow, worker, task, row, reservation, ready, drain,
    counts: () => ({ sourceLoads, stored }), close: async () => { await redis.close(); await sql.close(); } };
  } catch (error) { await redis.close(); await sql.close(); throw error; }
}

integration("async workflows release execution slots, retain model quota, and recover their original IDs after PostgreSQL lease expiry and Redis loss", async () => {
  const jobs = new Map<string, number>();
  let posts = 0, active = 0, maximum = 0;
  const h = await fixture(async (url, init) => {
    if (init?.method === "POST") {
      const id = JSON.parse(String(init.body)).id;
      expect(jobs.has(id)).toBe(false); jobs.set(id, 0); posts++; active++; maximum = Math.max(maximum, active);
      return Response.json({ job: { id } });
    }
    const id = decodeURIComponent(url.split("/status/")[1]!);
    expect(jobs.has(id)).toBe(true);
    const poll = jobs.get(id)! + 1; jobs.set(id, poll);
    if (poll === 1) return Response.json({ state: "RUNNING" });
    active--; return Response.json({ state: "DONE", outputs: ["https://result.invalid/image.png"] });
  });
  try {
    for (let i = 0; i < 6; i++) await h.task();
    await h.ready(); await h.drain();
    expect(posts).toBe(2); expect([...jobs.values()]).toEqual([0, 0]);
    const parked = (await h.db.query("SELECT id,upstream_task_id,upstream_workflow_context,poll_deadline_at,queued_at FROM tasks WHERE status='processing' ORDER BY id")).rows;
    expect(parked).toHaveLength(2);
    expect((await h.db.query("SELECT count(*)::int AS n FROM tasks WHERE status='processing' AND execution_token IS NULL AND lease_expires_at IS NULL AND model_slot_token IS NOT NULL")).rows[0].n).toBe(2);
    await h.redis.clear();
    await h.db.query("UPDATE tasks SET execution_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',model_slot_expires_at=now()-interval '1 second' WHERE status='processing'");
    await restoreWaitingTasksToQueue(h.db, h.redis.cache);
    expect((await h.db.query("SELECT id,upstream_task_id,upstream_workflow_context,poll_deadline_at,queued_at FROM tasks WHERE status='processing' ORDER BY id")).rows).toEqual(parked);
    for (let i = 0; i < 10; i++) { await h.ready(); await h.drain(); if (h.counts().stored === 6) break; }
    expect(posts).toBe(6); expect(maximum).toBe(2); expect(active).toBe(0);
    expect([...jobs.values()]).toEqual([2, 2, 2, 2, 2, 2]); expect(h.counts()).toEqual({ sourceLoads: 6, stored: 6 });
    expect((await h.db.query("SELECT status,count(*)::int AS n,min(attempts)::int AS attempts FROM tasks GROUP BY status")).rows).toEqual([{ status: "success", n: 6, attempts: 1 }]);
    expect((await h.db.query("SELECT count(*)::int AS n FROM credit_reservations WHERE status='captured'")).rows[0].n).toBe(6);
    expect((await h.db.query("SELECT count(*)::int AS n FROM generation_history")).rows[0].n).toBe(6);
    expect((await h.db.query("SELECT count(*)::int AS n FROM tasks WHERE model_slot_token IS NOT NULL OR execution_token IS NOT NULL")).rows[0].n).toBe(0);
  } finally { await h.close(); }
}, 60_000);

integration("changed workflow config pauses before GET; restoring it resumes the same held ID with its configured 37-second deadline", async () => {
  const calls: string[] = [];
  const h = await fixture(async (_url, init) => { calls.push(init?.method ?? "GET"); return init?.method === "POST" ? Response.json({ job: { id: "original" } }) : Response.json({ state: "RUNNING" }); });
  try {
    const id = await h.task(); await h.worker.runTask(id);
    const submitted = await h.row(id), held = await h.reservation(id);
    await h.db.query("UPDATE providers SET base_url='https://changed.invalid' WHERE id=$1", [h.provider]);
    await h.ready(); await h.drain();
    expect((await h.row(id)).status).toBe("paused"); expect(calls).toEqual(["POST"]); expect(await h.reservation(id)).toEqual(held);
    await h.db.query("UPDATE providers SET base_url='https://workflow.invalid' WHERE id=$1", [h.provider]);
    await h.db.query("UPDATE tasks SET poll_deadline_at=now()-interval '1 hour' WHERE id=$1", [id]);
    const before = Date.now();
    expect(await transitionTask(h.db, h.redis.cache, id, "resume")).not.toBeNull();
    const resumed = await h.row(id), deadline = new Date(resumed.poll_deadline_at).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + 37_000); expect(deadline).toBeLessThanOrEqual(Date.now() + 37_000);
    for (const field of ["upstream_task_id", "upstream_submission_started_at", "upstream_workflow_context", "attempts", "queued_at", "model_slot_token"])
      expect(resumed[field]).toEqual(submitted[field]);
    expect(await h.reservation(id)).toEqual(held);
    await h.drain(); expect(calls).toEqual(["POST", "GET"]);
    expect((await h.row(id)).status).toBe("processing"); expect(new Date((await h.row(id)).poll_deadline_at).getTime()).toBe(deadline);
  } finally { await h.close(); }
}, 30_000);

integration("unknown workflow submission keeps reservation and model slot, cannot resume without an ID, and is not automatically replayed", async () => {
  let posts = 0;
  const h = await fixture(async () => { posts++; throw new Error("unknown network outcome"); });
  try {
    const id = await h.task(); await h.worker.runTask(id);
    const row = await h.row(id);
    expect(row.status).toBe("paused"); expect(row.upstream_task_id).toBeNull(); expect(row.upstream_workflow_context.version).toBe(1);
    expect(row.upstream_submission_started_at).not.toBeNull(); expect(row.model_slot_token).not.toBeNull(); expect(row.attempts).toBe(1);
    expect((await h.reservation(id)).status).toBe("held");
    expect(await transitionTask(h.db, h.redis.cache, id, "resume")).toBeNull();
    await h.redis.clear(); await restoreWaitingTasksToQueue(h.db, h.redis.cache); await h.drain();
    expect(posts).toBe(1); expect((await h.db.query("SELECT count(*)::int AS n FROM generation_history")).rows[0].n).toBe(0);
  } finally { await h.close(); }
}, 30_000);

integration("an ID received after losing execution ownership is durably recorded and recovered using GET only", async () => {
  const calls: string[] = [];
  let id = "";
  const h = await fixture(async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "POST") {
      await h.db.query("UPDATE tasks SET execution_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second' WHERE id=$1", [id]);
      return Response.json({ job: { id: "original" } });
    }
    return Response.json({ outputs: ["https://result.invalid/image.png"] });
  });
  try {
    id = await h.task();
    await expect(h.worker.runTask(id)).rejects.toBeInstanceOf(TaskExecutionLost);
    expect((await h.row(id)).upstream_task_id).toBe("original"); expect((await h.reservation(id)).status).toBe("held");
    await h.redis.clear(); await restoreWaitingTasksToQueue(h.db, h.redis.cache); await h.drain();
    expect(calls).toEqual(["POST", "GET"]); expect((await h.row(id)).status).toBe("success"); expect((await h.row(id)).attempts).toBe(1);
    expect((await h.reservation(id)).status).toBe("captured");
  } finally { await h.close(); }
}, 30_000);

integration("synchronous workflow output still captures exactly once without entering the polling queue", async () => {
  let posts = 0;
  const h = await fixture(async () => { posts++; return Response.json({ outputs: ["https://result.invalid/image.png"] }); });
  try {
    const id = await h.task(); await h.worker.runTask(id);
    expect((await h.row(id)).status).toBe("success"); expect((await h.row(id)).upstream_task_id).toBeNull();
    expect((await h.reservation(id)).status).toBe("captured"); expect(posts).toBe(1);
    expect(await h.redis.zCard("tasks:delayed")).toBe(0); expect(h.counts()).toEqual({ sourceLoads: 1, stored: 1 });
  } finally { await h.close(); }
}, 30_000);

for (const mode of ["submission-rejected", "status-unavailable", "reported-failed"] as const)
integration(`workflow ${mode} preserves the existing settlement policy without replay`, async () => {
  const calls: string[] = [];
  const h = await fixture(async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "POST") return mode === "submission-rejected" ? new Response("fixture", { status: 400 }) : Response.json({ job: { id: "original" } });
    return mode === "status-unavailable" ? new Response("fixture", { status: 503 }) : Response.json({ state: "FAILED" });
  });
  try {
    const id = await h.task(); await h.worker.runTask(id);
    if (mode !== "submission-rejected") { await h.ready(); await h.drain(); }
    const row = await h.row(id);
    expect(row.status).toBe(mode === "submission-rejected" ? "failed" : "paused");
    expect((await h.reservation(id)).status).toBe(mode === "submission-rejected" ? "released" : "held");
    expect(Boolean(row.model_slot_token)).toBe(mode !== "submission-rejected");
    expect(calls).toEqual(mode === "submission-rejected" ? ["POST"] : ["POST", "GET"]);
    expect(row.attempts).toBe(1);
  } finally { await h.close(); }
}, 30_000);
