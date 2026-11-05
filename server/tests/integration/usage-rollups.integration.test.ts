import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { queueUsageRollup, getUsageRollupJob, processUsageRollups, scheduleUsageRollupMaintenance } from "../../src/usage-rollups";
import { usageV2Overview, usageV2Models, usageV2Quality, usageV2Boards } from "../../src/usage-analytics-v2";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

sqlTest("daily analytics migration provides durable exact facts and dirty-day queue without enabling telemetry", async () => {
  const fixture = await createIsolatedPostgres();
  try {
    const tables = (await fixture.db.query("SELECT to_regclass('usage_daily_facts') AS facts,to_regclass('usage_daily_snapshots') AS snapshots,to_regclass('usage_dirty_days') AS dirty,to_regclass('usage_source_invalidations') AS source,to_regclass('usage_sessions') AS sessions")).rows[0];
    expect(tables.facts).toBe("usage_daily_facts");
    expect(tables.snapshots).toBe("usage_daily_snapshots");
    expect(tables.dirty).toBe("usage_dirty_days");
    expect(tables.source).toBe("usage_source_invalidations");
    expect(tables.sessions).toBeNull();
  } finally { await fixture.close(); }
}, 120000);

const scope: UsageV2Scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-03T00:00:00+08:00", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "at_event" };
const daily = { source: "daily" as const };
async function setup() {
  const fixture = await createIsolatedPostgres({ usageRollupsEnabled: true }), db = fixture.db;
  const user = randomUUID(), actor = randomUUID(), oldDepartment = randomUUID(), currentDepartment = randomUUID(), provider = randomUUID(), model = randomUUID();
  await db.query("INSERT INTO departments(id,name,code) VALUES($1,'Old','old'),($2,'Current','current')", [oldDepartment, currentDepartment]);
  await db.query("INSERT INTO users(id,username,display_name,role,must_change_password,department_id) VALUES($1,'generator','Generator','super_admin',false,$3),($2,'actor','Actor','designer',false,$3)", [user, actor, currentDepartment]);
  await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Fixture','openai','https://never-called.invalid','unused')", [provider]);
  await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'Model','fixture-model',ARRAY['generate'],999)", [model, provider]);
  const taskIds: string[] = [];
  for (const [day, duration, cost] of [[1, 10, "0.100001"], [1, 20, "0.200002"], [2, 1000, "0.300003"]] as const) {
    const id = randomUUID(), at = `2026-09-0${day}T01:00:00Z`;
    await db.query("INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'SECRET prompt','{\"quality\":\"high\",\"privateExtra\":\"SECRET\"}','image','success','[\"https://private.invalid/SECRET.png\"]',$5,$5,$6)", [id, user, oldDepartment, model, at, new Date(Date.parse(at) + duration).toISOString()]);
    await db.query("INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1", [id, cost]);
    taskIds.push(id);
  }
  const primary = randomUUID(), original = randomUUID();
  for (const [id, role] of [[primary, "primary"], [original, "provider-original"]]) {
    const metadata = { imageResult: { version: 1, role, resultIndex: 0, original: { assetId: original, mimeType: "image/png", filename: "SECRET.png" }, export: { assetId: primary, mimeType: "image/png", filename: "SECRET.png" }, maskComposited: false } };
    await db.query("INSERT INTO assets(id,owner_user_id,department_id,task_id,object_key,filename,mime_type,kind,status,metadata) VALUES($1,$2,$3,$4,$1::uuid::text,'SECRET.png','image/png','image','ready',$5)", [id, user, oldDepartment, taskIds[0], JSON.stringify(metadata)]);
  }
  await db.query("UPDATE generation_history SET result_urls=$2 WHERE task_id=$1", [taskIds[0], JSON.stringify([`/api/assets/${primary}/content`, `/api/assets/${original}/content`])]);
  await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T02:00:00Z')", [randomUUID(), user]);
  await db.query("INSERT INTO prompt_recipes(key,settings,updated_at) VALUES('fixture','{}',now())");
  await db.query("INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES('version','fixture',1,'hash','{}','fixture',now())");
  await db.query("INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,details,created_at) VALUES('original',$1,'compile-original','hash','fixture','version','success','{\"actualCost\":0.123456,\"currency\":\"USD\",\"inputTokens\":100}',now())", [user]);
  await db.query("INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,reused_from_id,details,created_at) VALUES('cached',$1,'compile-cached','hash','fixture','version','success','original','{\"actualCost\":9,\"currency\":\"USD\",\"inputTokens\":999}',now())", [user]);
  await db.query("UPDATE tasks SET prompt_compilation_id=CASE WHEN id=$1 THEN 'original' ELSE 'cached' END,prompt_optimized=true WHERE id=ANY($2::uuid[])", [taskIds[0], taskIds]);
  const refresh = async (fromDay = "2026-09-01", toDay = "2026-09-02") => {
    const job = await queueUsageRollup(db, { fromDay, toDay, idempotencyKey: randomUUID() }, user);
    const steps = await processUsageRollups(db, toDay === fromDay ? 1 : 2);
    expect(steps.every(step => step.status === "processed")).toBe(true);
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    return job;
  };
  return { ...fixture, user, actor, oldDepartment, currentDepartment, model, taskIds, primary, original, refresh };
}

sqlTest("exact daily facts preserve live metrics, all duration samples, department snapshots and compound filters; refresh is idempotent and free", async () => {
  const f = await setup(), db = f.db;
  try {
    const live = await usageV2Overview(db, scope);
    await expect(usageV2Overview(db, scope, daily)).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
    const input = { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() };
    const queued = await queueUsageRollup(db, input, f.user);
    expect(queued.status).toBe("queued");
    expect((await db.query("SELECT count(*)::int AS n FROM usage_daily_facts")).rows[0].n).toBe(0);
    expect((await queueUsageRollup(db, input, f.user)).jobId).toBe(queued.jobId);
    await expect(queueUsageRollup(db, { ...input, toDay: "2026-09-01" }, f.user)).rejects.toMatchObject({ code: "USAGE_ROLLUP_KEY_CONFLICT" });
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect(await getUsageRollupJob(db, queued.jobId)).toMatchObject({ status: "running", completedDays: ["2026-09-01"] });
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    const result = await usageV2Overview(db, scope, daily);
    expect(result.metrics).toEqual(live.metrics);
    expect(result.daily).toEqual(live.daily);
    expect(result.metrics.totalMsP50.value).toBe(20);
    expect(result.metrics.totalMsP90.value).toBe(804);
    expect(result.metrics.generationBookedCny.amount).toBe("0.600006");
    expect(result.metrics.activePeople.value).toBe(1);
    expect(result.meta.dataMode).toBe("persisted_daily_facts");
    expect(result.meta.snapshot).toMatchObject({ dayCount: 2, mixedSnapshots: true });
    expect(result.meta.asOf).toBe(result.meta.snapshot!.newestComputedAt);
    expect(result.meta.computedThrough).toBe(result.meta.snapshot!.oldestComputedAt);
    expect(JSON.stringify((await db.query("SELECT payload FROM usage_daily_facts")).rows)).not.toContain("SECRET");
    const marker = f.statements.length;
    await usageV2Overview(db, scope, daily);
    expect(f.statements.slice(marker).some(sql => sql.includes("FROM tasks t JOIN users"))).toBe(false);
    for (const selected of [
      { ...scope, departmentIds: [f.oldDepartment], userIds: [f.user], boardKeys: ["image"], modelConfigIds: [f.model], operationTypes: ["image_generation"] },
      { ...scope, departmentBasis: "current" as const, departmentIds: [f.currentDepartment] },
      { ...scope, departmentIds: [f.currentDepartment] },
      { ...scope, userIds: [f.actor] },
    ]) expect((await usageV2Overview(db, selected, daily)).metrics).toEqual((await usageV2Overview(db, selected)).metrics);
    expect((await usageV2Overview(db, { ...scope, departmentIds: [f.oldDepartment] }, daily)).metrics.visits.value).toBe(0);
    expect((await usageV2Models(db, scope, daily)).optimizationCosts).toEqual((await usageV2Models(db, scope)).optimizationCosts);
    expect((await usageV2Models(db, scope, daily)).optimizationCosts.costs[0]?.providerReportedAmount).toBe("0.123456");
    expect((await usageV2Boards(db, scope, daily)).boards).toEqual((await usageV2Boards(db, scope)).boards);
    const snapshots = (await db.query("SELECT * FROM usage_daily_snapshots ORDER BY day")).rows;
    expect((await queueUsageRollup(db, input, f.user)).status).toBe("completed");
    expect((await db.query("SELECT * FROM usage_daily_snapshots ORDER BY day")).rows).toEqual(snapshots);
    expect((await db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM usage_analysis_previews")).rows[0].n).toBe(0);
  } finally { await f.close(); }
}, 120000);

sqlTest("late use and reversal on an old generated variant dirty the original day; later settlement, cache source and event edits cannot leave stale history", async () => {
  const f = await setup(), db = f.db;
  try {
    await f.refresh();
    const receipt = randomUUID();
    await db.query("INSERT INTO asset_events(id,asset_id,designer_user_id,actor_user_id,task_id,event_type,idempotency_key,occurred_at) VALUES($1,$2,$3,$4,$5,'asset.adopted',$1::uuid::text,now())", [receipt, f.original, f.user, f.actor, f.taskIds[0]]);
    expect((await db.query("SELECT day::text FROM usage_source_invalidations WHERE day='2026-09-01'")).rows).toHaveLength(1);
    await expect(usageV2Quality(db, scope, daily)).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
    await f.refresh("2026-09-01", "2026-09-01");
    let quality = await usageV2Quality(db, scope, daily);
    expect(quality.resultUse).toMatchObject({ generatedImages: 3, usedImages: 1, formallyAdoptedImages: 1 });
    expect((await usageV2Quality(db, { ...scope, userIds: [f.actor] }, daily)).resultUse.usedImages).toBe(0);
    await db.query("INSERT INTO asset_events(id,asset_id,designer_user_id,actor_user_id,task_id,event_type,idempotency_key,source_event_id,occurred_at) VALUES($1,$2,$3,$4,$5,'asset.event_reversed',$1::uuid::text,$6,now())", [randomUUID(), f.original, f.user, f.actor, f.taskIds[0], receipt]);
    await f.refresh("2026-09-01", "2026-09-01");
    quality = await usageV2Quality(db, scope, daily);
    expect(quality.resultUse).toMatchObject({ usedImages: 0, formallyAdoptedImages: 0 });
    expect(quality.metrics).toEqual((await usageV2Quality(db, scope)).metrics);
    await db.query("UPDATE generation_history SET rmb_cost=0.900009 WHERE task_id=$1", [f.taskIds[0]]);
    await db.query("UPDATE usage_events SET occurred_at='2026-09-02T02:00:00Z'");
    await db.query("UPDATE prompt_compilations SET details='{\"actualCost\":0.2,\"currency\":\"USD\",\"inputTokens\":100}' WHERE id='original'");
    expect((await db.query("SELECT DISTINCT day::text FROM usage_source_invalidations WHERE day BETWEEN '2026-09-01' AND '2026-09-02' ORDER BY day")).rows).toEqual([{ day: "2026-09-01" }, { day: "2026-09-02" }]);
    await f.refresh();
    expect((await usageV2Overview(db, scope, daily)).metrics.generationBookedCny.amount).toBe("1.400014");
    expect((await usageV2Models(db, scope, daily)).optimizationCosts.costs[0]?.providerReportedAmount).toBe("0.200000");
    expect((await usageV2Overview(db, scope, daily)).daily).toEqual((await usageV2Overview(db, scope)).daily);
  } finally { await f.close(); }
}, 120000);

sqlTest("refresh HTTP is super-admin only, bounded, asynchronous, no-store and idempotent; GET never rebuilds history", async () => {
  const f = await setup(), db = f.db;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    let role = "designer";
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { Object.assign(request, { auth: { id: f.user, role, departmentId: f.currentDepartment } }); next(); });
    app.use("/usage", createAdminUsageRouter(db, {} as AppConfig));
    app.use(((error, _request, response, _next) => response.status(500).json({ message: error.message })) as ErrorRequestHandler);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/usage`;
    const input = { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() };
    const post = (body = input) => fetch(`${base}/rollups/recompute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const denied of ["designer", "department_admin"]) {
      role = denied;
      for (const response of [await post(), await fetch(`${base}/rollups/jobs/${randomUUID()}`)]) {
        expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect((await db.query("SELECT count(*)::int AS n FROM usage_rollup_jobs")).rows[0].n).toBe(0);
    role = "super_admin";
    await db.query("UPDATE usage_rollup_state SET processing_enabled=false WHERE singleton=true");
    const disabled = await post();
    expect(disabled.status).toBe(503); expect(disabled.headers.get("cache-control")).toBe("no-store");
    expect((await disabled.json()).code).toBe("USAGE_ROLLUP_NOT_ENABLED");
    expect((await db.query("SELECT count(*)::int AS n FROM usage_rollup_jobs")).rows[0].n).toBe(0);
    await db.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    const query = new URLSearchParams({ from: scope.from, to: scope.to, compare: "none" });
    const missing = await fetch(`${base}/overview?${query}`);
    expect(missing.status).toBe(409); expect((await missing.json()).code).toBe("USAGE_ROLLUP_REFRESH_REQUIRED");
    expect((await db.query("SELECT count(*)::int AS n FROM usage_daily_facts")).rows[0].n).toBe(0);
    for (const body of [{ ...input, toDay: "2026-10-02" }, { ...input, fromDay: "2026-02-30" }, { ...input, toDay: "2999-12-31" }]) expect((await post(body)).status).toBe(400);
    const response = await post(); expect(response.status).toBe(202); expect(response.headers.get("cache-control")).toBe("no-store");
    const job = (await response.json()).data;
    expect(job.status).toBe("queued"); expect((await (await post()).json()).data.jobId).toBe(job.jobId);
    const status = await fetch(`${base}/rollups/jobs/${job.jobId}`);
    expect(status.headers.get("cache-control")).toBe("no-store"); expect((await status.json()).data.status).toBe("queued");
    await processUsageRollups(db, 2);
    const complete = await fetch(`${base}/rollups/jobs/${job.jobId}`);
    expect((await complete.json()).data).toMatchObject({ status: "completed", completedDays: ["2026-09-01", "2026-09-02"] });
    expect((await post()).status).toBe(200);
    const read = await fetch(`${base}/overview?${query}`);
    expect(read.status).toBe(200); expect((await read.json()).data.meta.dataMode).toBe("persisted_daily_facts");
    expect(JSON.stringify((await db.query("SELECT detail FROM audit_logs WHERE action='usage.rollups.requested'")).rows)).not.toContain("SECRET");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await f.close();
  }
}, 120000);

sqlTest("failed day replacement rolls back facts and watermark; completed earlier days survive and the same request does not retry", async () => {
  const f = await setup(), db = f.db;
  try {
    await f.refresh();
    const before = (await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-02'")).rows;
    const beforeFacts = (await db.query("SELECT payload FROM usage_daily_facts WHERE day='2026-09-02' ORDER BY fact_id")).rows;
    await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [f.taskIds[2]]);
    await db.query("CREATE FUNCTION fixture_fail_day() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.day='2026-09-02' THEN RAISE EXCEPTION 'synthetic interrupted write'; END IF; RETURN NEW; END $$");
    await db.query("CREATE TRIGGER fixture_fail_day BEFORE INSERT ON usage_daily_facts FOR EACH ROW EXECUTE FUNCTION fixture_fail_day()");
    const input = { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() };
    const job = await queueUsageRollup(db, input, f.user);
    expect((await processUsageRollups(db, 2)).map(step => step.status)).toEqual(["processed", "failed"]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "failed", completedDays: ["2026-09-01"], failureCode: "USAGE_ROLLUP_COMPUTE_FAILED" });
    expect((await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-02'")).rows).toEqual(before);
    expect((await db.query("SELECT payload FROM usage_daily_facts WHERE day='2026-09-02' ORDER BY fact_id")).rows).toEqual(beforeFacts);
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-02'")).rows[0].failure_code).toBe("USAGE_ROLLUP_COMPUTE_FAILED");
    expect((await queueUsageRollup(db, input, f.user)).status).toBe("failed");
    await db.query("DROP TRIGGER fixture_fail_day ON usage_daily_facts");
    await db.query("DROP FUNCTION fixture_fail_day()");
    await f.refresh("2026-09-02", "2026-09-02");
    expect((await usageV2Overview(db, scope, daily)).metrics.failed.value).toBe(1);
  } finally { await f.close(); }
}, 120000);

sqlTest("a PostgreSQL serialization conflict defers the same job without clearing dirty or falsely completing its day", async () => {
  const f = await setup(), db = f.db;
  try {
    await f.refresh();
    const before = (await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-02'")).rows;
    await db.query("UPDATE tasks SET status='failed' WHERE id=$1", [f.taskIds[2]]);
    await db.query("CREATE FUNCTION fixture_serialization_conflict() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.day='2026-09-02' THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='synthetic serialization conflict'; END IF; RETURN NEW; END $$");
    await db.query("CREATE TRIGGER fixture_serialization_conflict BEFORE INSERT ON usage_daily_facts FOR EACH ROW EXECUTE FUNCTION fixture_serialization_conflict()");
    const input = { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() };
    const job = await queueUsageRollup(db, input, f.user);
    expect(await processUsageRollups(db, 2)).toEqual([{ status: "processed", day: "2026-09-01", jobId: job.jobId }, { status: "deferred" }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "running", completedDays: ["2026-09-01"], failureCode: null });
    expect((await queueUsageRollup(db, input, f.user)).jobId).toBe(job.jobId);
    expect((await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-02'")).rows).toEqual(before);
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-02'")).rows).toEqual([{ failure_code: null }]);
    await db.query("DROP TRIGGER fixture_serialization_conflict ON usage_daily_facts");
    await db.query("DROP FUNCTION fixture_serialization_conflict()");
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "completed", completedDays: ["2026-09-01", "2026-09-02"], failureCode: null });
  } finally { await f.close(); }
}, 120000);

sqlTest("maintenance starts the seven completed Beijing days at 03:00, is restart-idempotent and retains older dirty days", async () => {
  const f = await createIsolatedPostgres({ usageRollupsEnabled: true }), db = f.db;
  try {
    await scheduleUsageRollupMaintenance(db, new Date("2026-09-20T18:59:00Z"));
    expect((await db.query("SELECT last_scheduled_day FROM usage_rollup_state")).rows[0].last_scheduled_day).toBeNull();
    await scheduleUsageRollupMaintenance(db, new Date("2026-09-20T19:00:00Z"));
    expect((await db.query("SELECT last_scheduled_day::text AS day FROM usage_rollup_state")).rows[0].day).toBe("2026-09-21");
    const pending = (await db.query("SELECT day::text,dirty_at FROM usage_dirty_days WHERE day BETWEEN '2026-09-14' AND '2026-09-20' ORDER BY day")).rows;
    expect(pending).toHaveLength(7);
    await db.query("SELECT usage_mark_dirty_day('2026-01-01T01:00:00Z')");
    await scheduleUsageRollupMaintenance(db, new Date("2026-09-20T20:00:00Z"));
    expect((await db.query("SELECT day::text,dirty_at FROM usage_dirty_days WHERE day BETWEEN '2026-09-14' AND '2026-09-20' ORDER BY day")).rows).toEqual(pending);
    expect((await db.query("SELECT day::text FROM usage_dirty_days WHERE day='2026-01-01'")).rows).toHaveLength(1);
  } finally { await f.close(); }
}, 120000);

sqlTest("history over 50000 small facts reads persisted exact samples without the old row cap, but expanded payload still has a 32MiB guard", async () => {
  const f = await createIsolatedPostgres({ usageRollupsEnabled: true }), db = f.db;
  try {
    const user = randomUUID();
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'large','Large','super_admin',false)", [user]);
    await db.query(`INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at)
      SELECT gen_random_uuid(),$1,'image','visit','{}',CASE WHEN i<=25000 THEN '2026-09-01T01:00:00Z'::timestamptz ELSE '2026-09-02T01:00:00Z'::timestamptz END
      FROM generate_series(1,50001) i`, [user]);
    await expect(usageV2Overview(db, scope)).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE" });
    const job = await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() }, user);
    const steps = await processUsageRollups(db, 2);
    expect(steps).toEqual([{ status: "processed", day: "2026-09-01", jobId: job.jobId }, { status: "processed", day: "2026-09-02", jobId: job.jobId }]);
    const result = await usageV2Overview(db, scope, daily);
    expect(result.metrics.visits.value).toBe(50001);
    expect(result.metrics.activePeople.value).toBe(1);
    expect(result.metrics.activeDays.value).toBe(2);
    expect(result.daily.map(row => row.metrics.visits.value)).toEqual([25000, 25001]);
    // Distinct non-interchangeable payloads cannot be grouped. Highly TOAST-
    // compressible fields must still count toward the expanded return budget.
    await db.query("UPDATE usage_daily_facts SET payload=payload||jsonb_build_object('fixtureOversized',repeat('x',1000)||fact_id)");
    await expect(usageV2Overview(db, scope, daily)).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
  } finally { await f.close(); }
}, 180000);
