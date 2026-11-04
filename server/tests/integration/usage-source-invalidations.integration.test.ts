import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { drainUsageSourceInvalidations, processUsageRollups } from "../../src/usage-rollups";
import { usageV2Overview } from "../../src/usage-analytics-v2";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai" as const, compare: "none" as const, departmentBasis: "at_event" as const };
const persistedState = `SELECT (SELECT jsonb_agg(s) FROM usage_rollup_state s) AS state,
  (SELECT jsonb_agg(d ORDER BY day) FROM usage_dirty_days d) AS dirty,
  (SELECT jsonb_agg(i ORDER BY day,source_xid) FROM usage_source_invalidations i) AS source`;

sqlTest("source triggers coalesce transaction/day marks and preserve full transaction and savepoint rollback while processing is off", async () => {
  const f = await createIsolatedPostgres(), db = f.db, user = randomUUID(), task = randomUUID();
  const client = await db.connect();
  try {
    await client.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'source-journal','Source journal','super_admin',false)", [user]);
    const before = (await client.query(persistedState)).rows;
    const insertTask = () => client.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,queued_at) VALUES($1,$1::uuid::text,$2,'fixture','image_generation','2026-09-01T01:00:00Z')", [task, user]);
    await client.query("BEGIN");
    await insertTask();
    await client.query("UPDATE tasks SET status='failed' WHERE id=$1", [task]);
    await client.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T02:00:00Z')", [randomUUID(), user]);
    expect((await client.query("SELECT day::text,source_xid=pg_current_xact_id() AS same_transaction FROM usage_source_invalidations")).rows).toEqual([{ day: "2026-09-01", same_transaction: true }]);
    await client.query("SAVEPOINT source_change");
    await client.query("UPDATE tasks SET queued_at='2026-09-02T01:00:00Z' WHERE id=$1", [task]);
    expect((await client.query("SELECT count(*)::int AS n FROM usage_source_invalidations")).rows[0].n).toBe(2);
    await client.query("ROLLBACK TO SAVEPOINT source_change");
    expect((await client.query("SELECT day::text FROM usage_source_invalidations")).rows).toEqual([{ day: "2026-09-01" }]);
    await client.query("ROLLBACK");
    expect((await client.query(persistedState)).rows).toEqual(before);
    expect((await client.query("SELECT id FROM tasks WHERE id=$1", [task])).rows).toEqual([]);
    await client.query("BEGIN");
    await insertTask();
    await client.query("UPDATE tasks SET status='failed' WHERE id=$1", [task]);
    await client.query("COMMIT");
    expect((await client.query("SELECT day::text FROM usage_source_invalidations")).rows).toEqual([{ day: "2026-09-01" }]);
    expect((await client.query("SELECT day FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([]);
    expect((await client.query("SELECT jsonb_agg(s) AS state FROM usage_rollup_state s")).rows[0].state).toEqual(before[0].state);
  } finally { await client.query("ROLLBACK"); client.release(); await f.close(); }
}, 30000);

sqlTest("pending older source history is immediately dirty without GET writes or processing, then becomes exact after a drain and rebuild", async () => {
  const f = await createIsolatedPostgres(), db = f.db, user = randomUUID();
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'older-source','Older source','super_admin',false)", [user]);
    await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T01:00:00Z')", [randomUUID(), user]);
    const before = (await db.query(persistedState)).rows, marker = f.statements.length;
    await expect(usageV2Overview(db, scope, { source: "daily" })).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED", status: 409 });
    expect(f.statements.slice(marker).every(sql => /^(SELECT|WITH|BEGIN|SET|COMMIT|ROLLBACK)/.test(sql))).toBe(true);
    expect(await drainUsageSourceInvalidations(db)).toBe(0);
    expect((await db.query(persistedState)).rows).toEqual(before);
    await db.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    expect((await processUsageRollups(db, 1))[0]).toEqual({ status: "processed", day: "2026-09-01" });
    expect((await db.query("SELECT day FROM usage_source_invalidations")).rows).toEqual([]);
    expect((await usageV2Overview(db, scope, { source: "daily" })).metrics.visits.value).toBe(1);
    expect((await db.query("SELECT history_from::text AS day FROM usage_rollup_state")).rows).toEqual([{ day: "2026-09-01" }]);
  } finally { await f.close(); }
}, 30000);

sqlTest("a drain transfers at most 1000 committed markers and rolls history, dirty days and deletion back together", async () => {
  const f = await createIsolatedPostgres({ usageRollupsEnabled: true }), db = f.db;
  try {
    // Each call is its own real committed transaction, not an event counter or
    // fabricated xid. Repeated marks inside one transaction are covered above.
    for (let index = 0; index < 1003; index++) await db.query("SELECT usage_mark_dirty_day($1)", [index < 1001 ? "2026-09-01T01:00:00Z" : "2026-09-02T01:00:00Z"]);
    expect((await db.query("SELECT count(*)::int AS n FROM usage_source_invalidations")).rows[0].n).toBe(1003);
    const before = (await db.query(persistedState)).rows;
    await db.query("CREATE FUNCTION fixture_reject_journal_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic drain interruption'; END $$");
    await db.query("CREATE TRIGGER fixture_reject_journal_delete BEFORE DELETE ON usage_source_invalidations FOR EACH ROW EXECUTE FUNCTION fixture_reject_journal_delete()");
    await expect(drainUsageSourceInvalidations(db)).rejects.toMatchObject({ message: "synthetic drain interruption" });
    expect((await db.query(persistedState)).rows).toEqual(before);
    await db.query("DROP TRIGGER fixture_reject_journal_delete ON usage_source_invalidations");
    await db.query("DROP FUNCTION fixture_reject_journal_delete()");
    expect(await drainUsageSourceInvalidations(db)).toBe(1000);
    expect((await db.query("SELECT day::text,count(*)::int AS n FROM usage_source_invalidations GROUP BY day ORDER BY day")).rows).toEqual([{ day: "2026-09-01", n: 1 }, { day: "2026-09-02", n: 2 }]);
    expect((await db.query("SELECT day::text FROM usage_dirty_days WHERE day BETWEEN '2026-09-01' AND '2026-09-02' ORDER BY day")).rows).toEqual([{ day: "2026-09-01" }]);
    expect(await drainUsageSourceInvalidations(db)).toBe(3);
    expect((await db.query("SELECT day FROM usage_source_invalidations")).rows).toEqual([]);
    expect((await db.query("SELECT day::text FROM usage_dirty_days WHERE day BETWEEN '2026-09-01' AND '2026-09-02' ORDER BY day")).rows).toEqual([{ day: "2026-09-01" }, { day: "2026-09-02" }]);
    expect(await drainUsageSourceInvalidations(db)).toBe(0);
  } finally { await f.close(); }
}, 60000);
