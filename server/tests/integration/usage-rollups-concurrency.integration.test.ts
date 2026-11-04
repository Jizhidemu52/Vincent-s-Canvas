import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import type { Database } from "../../src/db";
import { drainUsageSourceInvalidations, getUsageRollupJob, processUsageRollups, queueUsageRollup, scheduleUsageRollupMaintenance } from "../../src/usage-rollups";
import { usageV2Overview } from "../../src/usage-analytics-v2";

// Deliberately not simulated by the single-connection PGlite fixture. Existing
// CI's RUN_INTEGRATION_TESTS=true pass supplies a disposable local PostgreSQL.
const integration = process.env.RUN_INTEGRATION_TESTS === "true" ? test : test.skip;
async function fixture() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || process.env.NODE_ENV !== "test") throw new Error("A test-only PostgreSQL URL and NODE_ENV=test are required");
  const target = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("Concurrent usage tests only allow a disposable localhost PostgreSQL");
  const schema = `usage_rollup_test_${randomUUID().replaceAll("-", "")}`;
  const control = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let db: Pool | undefined, created = false;
  const close = async () => {
    await db?.end();
    try { if (created && /^usage_rollup_test_[0-9a-f]{32}$/.test(schema)) await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await control.end(); }
  };
  try {
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    db = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=1000` });
    const migrations = new URL("../../src/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await db.query(await readFile(new URL(name, migrations), "utf8"));
    await db.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    return { db, close };
  } catch (error) { await close(); throw error; }
}

integration("a real concurrent source commit stays unblocked and durably invalidates a concurrent snapshot until the next worker tick", async () => {
  const f = await fixture(), db = f.db, user = randomUUID(), task = randomUUID();
  let resume: (() => void) | undefined, work: ReturnType<typeof processUsageRollups> | undefined;
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'concurrent','Concurrent','super_admin',false)", [user]);
    await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','success','2026-09-01T01:00:00Z','2026-09-01T01:00:00Z','2026-09-01T01:00:01Z')", [task, user]);
    await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    // The first drain makes this day dirty. A concurrent source transaction
    // must append independently instead of locking the shared dirty row.
    await db.query("SELECT usage_mark_dirty_day('2026-09-01T01:00:00Z')");
    const input = { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() };
    const job = await queueUsageRollup(db, input, user);
    let paused!: () => void;
    const reached = new Promise<void>(resolve => { paused = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let held = false;
    // Real driver and SQL results, with a deterministic transport pause after
    // reading source facts. No query/transaction result is mocked.
    const workerDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (!held && sql.includes("SELECT f.*,f.event_department_id AS department_id")) { held = true; paused(); await gate; }
        return result;
      } };
    } } as unknown as Database;
    work = processUsageRollups(workerDb, 1);
    await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rollup source pause not reached")), 5000))]);
    const writer = await db.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='500ms'");
      await writer.query("UPDATE tasks SET status='failed' WHERE id=$1", [task]);
      await writer.query("COMMIT");
    } catch (error) { await writer.query("ROLLBACK"); throw error; }
    finally { writer.release(); }
    resume!();
    expect(await work).toEqual([{ status: "processed", day: "2026-09-01", jobId: job.jobId }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "completed", completedDays: ["2026-09-01"], failureCode: null });
    expect((await queueUsageRollup(db, input, user)).jobId).toBe(job.jobId);
    expect((await db.query("SELECT payload->>'status' AS status FROM usage_daily_facts WHERE fact_id=$1", [task])).rows).toEqual([{ status: "success" }]);
    expect((await db.query("SELECT day::text FROM usage_source_invalidations WHERE day='2026-09-01'")).rows).toEqual([{ day: "2026-09-01" }]);
    const scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai" as const, compare: "none" as const, departmentBasis: "at_event" as const };
    await expect(usageV2Overview(db, scope, { source: "daily" })).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED", status: 409 });
    // A new invocation (including worker restart) consumes the durable marker.
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    expect((await queueUsageRollup(db, input, user)).jobId).toBe(job.jobId);
    expect((await db.query("SELECT day FROM usage_source_invalidations WHERE day='2026-09-01'")).rows).toEqual([]);
    const result = await usageV2Overview(db, scope, { source: "daily" });
    expect(result.metrics.failed.value).toBe(1);
  } finally { resume?.(); await work?.catch(() => undefined); await f.close(); }
}, 60000);

async function waitForControlLock(db: Pool, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await db.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted", [pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("expected a real blocked analytics control lock");
}

async function waitForBusinessLock(db: Pool, blockedPid: number, blockerPid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await db.query("SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked", [blockedPid, blockerPid])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("expected the submission to wait for the real user billing lock");
}

integration("task submission and finalization cannot invert a shared analytics day lock with the user billing lock", async () => {
  const f = await fixture(), db = f.db, user = randomUUID(), task = randomUUID(), submitted = randomUUID();
  const worker = await db.connect(), api = await db.connect();
  let reserving: Promise<unknown> | undefined;
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'business-lock','Business lock','super_admin',false)", [user]);
    await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,queued_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','processing','2026-09-01T01:00:00Z')", [task, user]);
    await drainUsageSourceInvalidations(db);
    const workerPid = (await worker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const apiPid = (await api.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await worker.query("BEGIN");
    await worker.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [user]);
    await api.query("BEGIN");
    // FK KEY SHARE is compatible with the worker's billing lock. Previously
    // this insert then held the shared dirty row before asking for billing.
    await api.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,queued_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','2026-09-01T02:00:00Z')", [submitted, user]);
    reserving = api.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [user]);
    void reserving.catch(() => undefined);
    await waitForBusinessLock(db, apiPid, workerPid);
    await worker.query("UPDATE tasks SET status='success',completed_at='2026-09-01T01:00:01Z' WHERE id=$1", [task]);
    await worker.query("COMMIT");
    await reserving;
    await api.query("COMMIT");
    expect((await db.query("SELECT count(*)::int AS n FROM usage_source_invalidations WHERE day='2026-09-01'")).rows[0].n).toBe(2);
    expect((await db.query("SELECT id,status FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY status", [[submitted, task]])).rows).toEqual([{ id: task, status: "success" }, { id: submitted, status: "waiting" }]);
  } finally {
    await worker.query("ROLLBACK"); await reserving?.catch(() => undefined); await api.query("ROLLBACK");
    worker.release(); api.release(); await f.close();
  }
}, 60000);

integration("distinct business transactions mark opposite days without waiting, and drains ignore uncommitted or locked markers", async () => {
  const f = await fixture(), db = f.db, user = randomUUID(), firstEvent = randomUUID(), secondEvent = randomUUID();
  const first = await db.connect(), second = await db.connect();
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'opposite-days','Opposite days','super_admin',false)", [user]);
    await first.query("BEGIN"); await second.query("BEGIN");
    await first.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T01:00:00Z')", [firstEvent, user]);
    await second.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-02T01:00:00Z')", [secondEvent, user]);
    await first.query("UPDATE usage_events SET occurred_at='2026-09-02T02:00:00Z' WHERE event_id=$1", [firstEvent]);
    await second.query("UPDATE usage_events SET occurred_at='2026-09-01T02:00:00Z' WHERE event_id=$1", [secondEvent]);
    expect(await drainUsageSourceInvalidations(db)).toBe(0);
    await first.query("COMMIT");
    expect(await drainUsageSourceInvalidations(db)).toBe(2);
    await second.query("ROLLBACK");
    expect((await db.query("SELECT day FROM usage_source_invalidations")).rows).toEqual([]);
    expect((await db.query("SELECT event_id FROM usage_events WHERE event_id=$1", [secondEvent])).rows).toEqual([]);
    await db.query("SELECT usage_mark_dirty_day('2026-09-03T01:00:00Z')");
    await first.query("BEGIN");
    await first.query("SELECT day FROM usage_source_invalidations WHERE day='2026-09-03' FOR UPDATE");
    await db.query("SELECT usage_mark_dirty_day('2026-09-04T01:00:00Z')");
    expect(await drainUsageSourceInvalidations(db)).toBe(1);
    expect((await db.query("SELECT day::text FROM usage_source_invalidations")).rows).toEqual([{ day: "2026-09-03" }]);
    await first.query("ROLLBACK");
    expect(await drainUsageSourceInvalidations(db)).toBe(1);
  } finally {
    await first.query("ROLLBACK"); await second.query("ROLLBACK"); first.release(); second.release(); await f.close();
  }
}, 60000);

integration("a source commit after a failure mark is written remains pending and prevents stale failure completion", async () => {
  const f = await fixture(), db = f.db, user = randomUUID(), event = randomUUID();
  let resume: (() => void) | undefined, work: ReturnType<typeof processUsageRollups> | undefined;
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'failure-commit','Failure commit','super_admin',false)", [user]);
    await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T01:00:00Z')", [event, user]);
    const job = await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, user);
    let paused!: () => void;
    const reached = new Promise<void>(resolve => { paused = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let failed = false;
    const workerDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        if (!failed && sql.includes("SELECT f.*,f.event_department_id AS department_id")) { failed = true; throw new Error("synthetic connection failure before replacement"); }
        const result = await client.query(sql, values);
        if (sql.startsWith("UPDATE usage_dirty_days SET failure_code=")) { paused(); await gate; }
        return result;
      } };
    } } as unknown as Database;
    work = processUsageRollups(workerDb, 1);
    await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("failure mark pause not reached")), 5000))]);
    // The failed transaction holds the dirty row now. A business writer must
    // still finish and leave its own key for the next analytics drain.
    await db.query("UPDATE usage_events SET occurred_at='2026-09-01T02:00:00Z' WHERE event_id=$1", [event]);
    resume!();
    expect(await work).toEqual([{ status: "deferred" }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "queued", completedDays: [], failureCode: null });
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([{ failure_code: null }]);
    expect((await db.query("SELECT day::text FROM usage_source_invalidations")).rows).toEqual([{ day: "2026-09-01" }]);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    expect(new Date((await db.query("SELECT occurred_at FROM usage_daily_facts WHERE day='2026-09-01' AND kind='event'")).rows[0].occurred_at).toISOString()).toBe("2026-09-01T02:00:00.000Z");
  } finally { resume?.(); await work?.catch(() => undefined); await f.close(); }
}, 60000);

integration("disable waits for an active daily write, while source history invalidation remains unblocked", async () => {
  const f = await fixture(), db = f.db, user = randomUUID();
  const control = await db.connect();
  let resume: (() => void) | undefined, work: ReturnType<typeof processUsageRollups> | undefined;
  let disabling: Promise<unknown> | undefined;
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'disable-wait','Disable wait','super_admin',false)", [user]);
    await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T01:00:00Z')", [randomUUID(), user]);
    const job = await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, user);
    let paused!: () => void;
    const reached = new Promise<void>(resolve => { paused = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let held = false;
    const workerDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (!held && sql.includes("SELECT f.*,f.event_department_id AS department_id")) { held = true; paused(); await gate; }
        return result;
      } };
    } } as unknown as Database;
    work = processUsageRollups(workerDb, 1);
    await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rollup did not reach source pause")), 5000))]);
    const pid = (await control.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await control.query("BEGIN");
    await control.query("SET LOCAL lock_timeout='5000ms'");
    disabling = control.query("SELECT pg_advisory_xact_lock(hashtextextended('canvas:usage-rollup-control:v1',0))");
    await waitForControlLock(db, pid);
    // An older source write must not update or wait on history_from, even
    // while the worker holds SHARE and disable waits for its control lock.
    await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-08-31T01:00:00Z')", [randomUUID(), user]);
    expect((await db.query("SELECT history_from::text AS day FROM usage_rollup_state")).rows[0].day).toBe("2026-09-01");
    expect((await db.query("SELECT day::text FROM usage_source_invalidations WHERE day='2026-08-31'")).rows).toEqual([{ day: "2026-08-31" }]);
    resume!();
    expect((await work)[0]?.status).toBe("processed");
    await disabling;
    await control.query("UPDATE usage_rollup_state SET processing_enabled=false WHERE singleton=true");
    await control.query("COMMIT");
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    expect(await processUsageRollups(db, 1)).toEqual([{ status: "idle" }]);
    expect((await db.query("SELECT day::text FROM usage_source_invalidations WHERE day='2026-08-31'")).rows).toEqual([{ day: "2026-08-31" }]);
  } finally {
    resume?.(); await work?.catch(() => undefined); await disabling?.catch(() => undefined);
    await control.query("ROLLBACK"); control.release(); await f.close();
  }
}, 60000);

integration("writers waiting behind disable cannot use a repeatable-read snapshot of the former enabled state", async () => {
  const f = await fixture(), db = f.db, control = await db.connect();
  let resume: (() => void) | undefined, work: ReturnType<typeof processUsageRollups> | undefined;
  try {
    const job = await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, randomUUID());
    const before = (await db.query("SELECT * FROM usage_dirty_days ORDER BY day")).rows;
    let connected!: (pid: number) => void;
    const workerPid = new Promise<number>(resolve => { connected = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const workerDb = { connect: async () => {
      const client = await db.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ") {
          // The bounded READ COMMITTED drain has already finished. Establish
          // the actual RR snapshot before disable commits, then let its next
          // control-lock statement wait behind the exclusive operator lock.
          const row = (await client.query("SELECT pg_backend_pid() AS pid,pg_current_snapshot()")).rows[0];
          connected(row.pid); await gate;
        }
        return result;
      } };
    } } as unknown as Database;
    work = processUsageRollups(workerDb, 1);
    const pid = await Promise.race([workerPid, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("repeatable-read pause not reached")), 5000))]);
    await control.query("BEGIN");
    await control.query("SELECT pg_advisory_xact_lock(hashtextextended('canvas:usage-rollup-control:v1',0))");
    await control.query("UPDATE usage_rollup_state SET processing_enabled=false WHERE singleton=true");
    resume!();
    await waitForControlLock(db, pid);
    await control.query("COMMIT");
    expect((await work)[0]?.status).toBe("deferred");
    expect(await getUsageRollupJob(db, job.jobId)).toEqual(job);
    expect((await db.query("SELECT * FROM usage_daily_snapshots")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM usage_dirty_days ORDER BY day")).rows).toEqual(before);
    await scheduleUsageRollupMaintenance(db, new Date("2026-09-20T19:00:00Z"));
    await expect(queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, randomUUID())).rejects.toMatchObject({ code: "USAGE_ROLLUP_NOT_ENABLED", status: 503 });
    expect((await db.query("SELECT * FROM usage_dirty_days ORDER BY day")).rows).toEqual(before);
  } finally {
    resume?.(); await control.query("ROLLBACK"); await work?.catch(() => undefined); control.release(); await f.close();
  }
}, 60000);
