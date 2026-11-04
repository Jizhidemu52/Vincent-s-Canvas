import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import type { Database } from "../../src/db";
import { getUsageRollupJob, processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
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
    return { db, close };
  } catch (error) { await close(); throw error; }
}

integration("a real concurrent source commit is not blocked by rollup computation, defers stale replacement and survives worker restart", async () => {
  const f = await fixture(), db = f.db, user = randomUUID(), task = randomUUID();
  let resume: (() => void) | undefined, work: ReturnType<typeof processUsageRollups> | undefined;
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'concurrent','Concurrent','super_admin',false)", [user]);
    await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','success','2026-09-01T01:00:00Z','2026-09-01T01:00:00Z','2026-09-01T01:00:01Z')", [task, user]);
    await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    const originalSnapshot = (await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-01'")).rows;
    // Begin with a dirty row so the source commit must update it during the
    // snapshot. A long-held dirty-row lock would make the writer fail below.
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
    expect(await work).toEqual([{ status: "deferred" }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "queued", completedDays: [], failureCode: null });
    expect((await queueUsageRollup(db, input, user)).jobId).toBe(job.jobId);
    expect((await db.query("SELECT * FROM usage_daily_snapshots WHERE day='2026-09-01'")).rows).toEqual(originalSnapshot);
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([{ failure_code: null }]);
    // New invocation represents worker restart: the same durable job resumes.
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    const result = await usageV2Overview(db, { from: "2026-09-01T00:00:00+08:00", to: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "at_event" }, { source: "daily" });
    expect(result.metrics.failed.value).toBe(1);
  } finally { resume?.(); await work?.catch(() => undefined); await f.close(); }
}, 60000);
