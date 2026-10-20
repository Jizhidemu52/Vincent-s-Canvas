import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { createTasksRouter } from "../../src/routes/tasks";
import { readTaskProgress } from "../../src/task-progress";
import { scheduleQueuedTask } from "../../src/task-queue";
import { queueScore } from "../../src/tasks";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { createIsolatedQueueCache } from "../helpers/isolated-queue-cache";

const integration = process.env.PGLITE_RUNTIME_PATH && process.env.QUEUE_TEST_REDIS_URL ? test : test.skip;

async function fixture() {
  const sql = await createIsolatedPostgres();
  const redis = await createIsolatedQueueCache();
  const owner = randomUUID(), other = randomUUID(), provider = randomUUID(), model = randomUUID(), otherModel = randomUUID();
  await sql.db.query("INSERT INTO users(id,username,display_name) VALUES($1,'queue-owner','Owner'),($2,'queue-other','Other')", [owner, other]);
  await sql.db.query("INSERT INTO providers(id,name,protocol,base_url) VALUES($1,'Fixture','apimart','https://provider.invalid')", [provider]);
  await sql.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,concurrency_limit) VALUES($1,$2,'Fixture','image-model',2),($3,$2,'Other','other-model',2)", [model, provider, otherModel]);
  const base = Number((await sql.db.query("SELECT extract(epoch FROM now())*1000 AS ms")).rows[0].ms);
  async function task(modelId = model, ownerId = owner) {
    const id = randomUUID();
    await sql.db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt) VALUES($1,$2,$3,'fixture','image_generation',$4,'private prompt')", [id, `request-${id}`, ownerId, modelId]);
    return id;
  }
  async function samples() {
    for (let index = 0; index < 3; index++) {
      const id = await task();
      await sql.db.query("UPDATE tasks SET status='success',attempts=1,started_at=now()-interval '120 seconds',completed_at=now()-interval '60 seconds' WHERE id=$1", [id]);
    }
    // Recent-but-incomparable and invalid records must never become ETA samples.
    for (const patch of [
      "status='failed',attempts=1",
      "status='success',attempts=2",
      "status='success',attempts=1,operation_type='video_generation'",
    ]) {
      const id = await task();
      await sql.db.query(`UPDATE tasks SET ${patch},started_at=now()-interval '300 seconds',completed_at=now()-interval '1 second' WHERE id=$1`, [id]);
    }
  }
  return { ...sql, redis, owner, other, model, otherModel, base, task, samples, close: async () => { await redis.close(); await sql.close(); } };
}

integration("progress HTTP runs real SQL/Lua: priority/FIFO, delayed gates, inflight occupancy and private owner scope", async () => {
  const f = await fixture();
  const app = express();
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: request.headers["x-test-other"] ? f.other : f.owner, role: "designer", departmentId: null } }); next(); });
  app.use("/api/tasks", createTasksRouter(f.db, f.redis.cache));
  app.use(((error, _request, response, _next) => response.status(error.name === "ZodError" ? 400 : 500).json({ error: error.name })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const target = await f.task(), normal = await f.task(), urgent = await f.task(f.model, f.other), delayed = await f.task(), inflight = await f.task(), foreign = await f.task(f.otherModel), cancelled = await f.task();
    await f.samples();
    await f.db.query("UPDATE tasks SET status='processing',model_slot_token=gen_random_uuid(),model_slot_expires_at=now()-interval '1 second',upstream_submission_started_at=now()-interval '10 seconds',started_at=now()-interval '10 seconds',upstream_task_id='remote-original' WHERE id=$1", [inflight]);
    await f.db.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [cancelled]);
    for (const [id, score, due] of [
      [target, queueScore("normal", f.base + 20), f.base],
      [normal, queueScore("normal", f.base + 19), f.base],
      [urgent, queueScore("urgent", f.base + 100), f.base],
      [delayed, queueScore("urgent", f.base), f.base + 60_000],
      [inflight, queueScore("urgent", f.base), f.base],
      [foreign, queueScore("urgent", f.base), f.base],
      [cancelled, queueScore("urgent", f.base), f.base],
    ] as const) await scheduleQueuedTask(f.redis.cache, id, score, due, f.base);

    const response = await fetch(`${origin}/api/tasks/${target}/progress`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.progress).toMatchObject({ taskId: target, queuePosition: 3, estimatedRemainingSeconds: null, estimateReason: "queue_changing" });
    for (const privateValue of [urgent, normal, inflight, f.other, "private prompt", "remote-original"])
      expect(JSON.stringify(body)).not.toContain(privateValue);
    expect(await readTaskProgress(f.db, f.redis.cache, delayed, f.owner)).toMatchObject({ phase: "delayed", queuePosition: null });
    await f.db.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [delayed]);
    expect(await readTaskProgress(f.db, f.redis.cache, target, f.owner)).toMatchObject({ queuePosition: 3, estimatedWaitSeconds: 60, estimatedRemainingSeconds: 120, sampleCount: 3 });
    // Priority-score millisecond precision is checked by the real Lua JSON path.
    await f.redis.cache.zAdd("tasks:queue", { value: normal, score: queueScore("normal", f.base + 21) });
    expect(await readTaskProgress(f.db, f.redis.cache, target, f.owner)).toMatchObject({ queuePosition: 2 });
    const before = f.statements.length;
    const denied = await fetch(`${origin}/api/tasks/${target}/progress`, { headers: { "x-test-other": "1" } });
    expect(denied.status).toBe(404);
    expect(f.statements.length - before).toBe(1);
    expect((await fetch(`${origin}/api/tasks/not-a-uuid/progress`)).status).toBe(400);
    await f.db.query("UPDATE tasks SET status='paused' WHERE id=$1", [inflight]);
    expect(await readTaskProgress(f.db, f.redis.cache, target, f.owner)).toMatchObject({ queuePosition: 2, estimatedRemainingSeconds: null, estimateReason: "unresolved_inflight" });
    await f.db.query("UPDATE tasks SET status='success' WHERE id=$1", [target]);
    const terminalBefore = f.statements.length;
    expect(await readTaskProgress(f.db, f.redis.cache, target, f.owner)).toMatchObject({ phase: "complete", queuePosition: null });
    expect(f.statements.length - terminalBefore).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
}, 60_000);

integration("oversized queues and Redis outages degrade without a fabricated position or generation writes", async () => {
  const f = await fixture();
  try {
    const target = await f.task();
    await scheduleQueuedTask(f.redis.cache, target, queueScore("normal", f.base), f.base, f.base);
    const outageCache = { ...f.redis.cache, eval: async () => { throw new Error("fixture Redis unavailable"); } };
    const before = f.statements.length;
    expect(await readTaskProgress(f.db, outageCache, target, f.owner)).toMatchObject({ phase: "waiting", queuePosition: null, estimateReason: "queue_unavailable" });
    expect(f.statements.slice(before).every(sql => sql.trimStart().startsWith("SELECT"))).toBe(true);
    await f.db.query(`INSERT INTO tasks(request_id,user_id,project_id,operation_type,model_config_id,prompt)
      SELECT 'bulk-'||n,$1,'fixture','image_generation',$2,'private' FROM generate_series(1,1000) n`, [f.owner, f.model]);
    expect(await readTaskProgress(f.db, f.redis.cache, target, f.owner)).toMatchObject({ queuePosition: null, estimatedRemainingSeconds: null, estimateReason: "queue_too_large" });
    const snapshotSql = f.statements.at(-1)!;
    // Verify both partial indexes are usable by the exact production query.
    // This planner setting affects this disposable WASM database only.
    await f.db.query("SET enable_seqscan=off");
    const plan = await f.db.query(`EXPLAIN ${snapshotSql}`, [f.model, "image_generation", 1001]);
    const detail = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
    expect(detail).toContain("tasks_model_active_progress_idx");
    expect(detail).toContain("tasks_model_duration_sample_idx");
  } finally { await f.close(); }
}, 60_000);
