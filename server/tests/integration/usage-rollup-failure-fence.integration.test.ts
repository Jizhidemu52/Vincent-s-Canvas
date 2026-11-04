import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { getUsageRollupJob, processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { usageV2Overview } from "../../src/usage-analytics-v2";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai" as const, compare: "none" as const, departmentBasis: "at_event" as const };

/** Real SQL in a disposable engine. PGlite is single-connection: deliberately
 * interleave only after A's ROLLBACK, where no transaction is active. This is
 * a deterministic legal ordering, not a claim of real concurrent PG coverage. */
async function fixture() {
  const f = await createIsolatedPostgres(), raw = await f.db.connect();
  const query = (sql: string, values?: unknown[]) => raw.query(sql, values);
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const user = randomUUID(), event = randomUUID();
  await query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'failure-fence','Failure fence','super_admin',false)", [user]);
  await query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T02:00:00Z')", [event, user]);
  return {
    db, user, event,
    interrupt: (afterRollback: () => Promise<void>) => {
      let injected = false, handedOff = false;
      return { connect: async () => ({ release() {}, query: async (sql: string, values?: unknown[]) => {
        if (!injected && sql.includes("SELECT f.*,f.event_department_id AS department_id")) {
          injected = true;
          throw new Error("Synthetic transient connection-layer failure before replacement");
        }
        const response = await query(sql, values);
        if (injected && !handedOff && sql === "ROLLBACK") { handedOff = true; await afterRollback(); }
        return response;
      } }) } as unknown as Database;
    },
    close: async () => { raw.release(); await f.close(); },
  };
}

sqlTest("a late failure cannot mark a multi-day job failed after another worker commits that day", async () => {
  const f = await fixture(), db = f.db;
  try {
    const request = { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() };
    const job = await queueUsageRollup(db, request, f.user);
    const interrupted = f.interrupt(async () => {
      expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
      expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "running", completedDays: ["2026-09-01"] });
    });
    expect(await processUsageRollups(interrupted, 1)).toEqual([{ status: "deferred" }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "running", completedDays: ["2026-09-01"], failureCode: null });
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([]);
    expect((await usageV2Overview(db, scope, { source: "daily" })).metrics.visits.value).toBe(1);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, job.jobId)).status).toBe("completed");
    expect((await queueUsageRollup(db, request, f.user)).jobId).toBe(job.jobId);
  } finally { await f.close(); }
}, 30000);

sqlTest("a late background failure cannot re-dirty a day already rebuilt by another worker", async () => {
  const f = await fixture(), db = f.db;
  try {
    const interrupted = f.interrupt(async () => { expect((await processUsageRollups(db, 1))[0]).toEqual({ status: "processed", day: "2026-09-01" }); });
    expect(await processUsageRollups(interrupted, 1)).toEqual([{ status: "deferred" }]);
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([]);
    expect((await usageV2Overview(db, scope, { source: "daily" })).metrics.visits.value).toBe(1);
  } finally { await f.close(); }
}, 30000);

sqlTest("a late failure preserves a newly updated dirty row so changed business data can retry automatically", async () => {
  const f = await fixture(), db = f.db;
  try {
    const interrupted = f.interrupt(async () => {
      await db.query("UPDATE usage_events SET occurred_at='2026-09-01T03:00:00Z' WHERE event_id=$1", [f.event]);
    });
    expect(await processUsageRollups(interrupted, 1)).toEqual([{ status: "deferred" }]);
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([{ failure_code: null }]);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await db.query("SELECT occurred_at FROM usage_daily_facts WHERE day='2026-09-01'")).rows).toHaveLength(1);
    expect((await usageV2Overview(db, scope, { source: "daily" })).metrics.visits.value).toBe(1);
  } finally { await f.close(); }
}, 30000);

sqlTest("a late explicit refresh failure preserves dirty inserted after a formerly clean day", async () => {
  const f = await fixture(), db = f.db;
  try {
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    const job = await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, f.user);
    const interrupted = f.interrupt(async () => {
      await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T04:00:00Z')", [randomUUID(), f.user]);
    });
    expect(await processUsageRollups(interrupted, 1)).toEqual([{ status: "deferred" }]);
    expect(await getUsageRollupJob(db, job.jobId)).toMatchObject({ status: "queued", completedDays: [], failureCode: null });
    expect((await db.query("SELECT failure_code FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([{ failure_code: null }]);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await usageV2Overview(db, scope, { source: "daily" })).metrics.visits.value).toBe(2);
  } finally { await f.close(); }
}, 30000);
