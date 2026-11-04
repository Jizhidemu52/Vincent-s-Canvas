import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { getUsageRollupJob, processUsageRollups, queueUsageRollup, scheduleUsageRollupMaintenance } from "../../src/usage-rollups";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const request = () => ({ fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() });

sqlTest("migration leaves analytics processing disabled; queue and worker ticks cannot change its persisted state", async () => {
  const f = await createIsolatedPostgres(), db = f.db;
  try {
    expect((await db.query("SELECT * FROM usage_rollup_state")).rows[0].processing_enabled).toBe(false);
    const user = randomUUID();
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'control','Control','super_admin',false)", [user]);
    // Source writes must continue invalidating history while processing is off.
    await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-09-01T01:00:00Z')", [randomUUID(), user]);
    expect((await db.query("SELECT day::text FROM usage_dirty_days WHERE day='2026-09-01'")).rows).toEqual([{ day: "2026-09-01" }]);
    const before = (await db.query("SELECT (SELECT jsonb_agg(s) FROM usage_rollup_state s) AS state,(SELECT jsonb_agg(d ORDER BY day) FROM usage_dirty_days d) AS dirty")).rows;
    await expect(queueUsageRollup(db, request(), user)).rejects.toMatchObject({ code: "USAGE_ROLLUP_NOT_ENABLED", status: 503 });
    await scheduleUsageRollupMaintenance(db, new Date("2026-09-20T19:00:00Z"));
    expect(await processUsageRollups(db, 3)).toEqual([{ status: "idle" }]);
    expect((await db.query("SELECT (SELECT jsonb_agg(s) FROM usage_rollup_state s) AS state,(SELECT jsonb_agg(d ORDER BY day) FROM usage_dirty_days d) AS dirty")).rows).toEqual(before);
    expect((await db.query("SELECT (SELECT count(*)::int FROM usage_rollup_jobs) AS jobs,(SELECT count(*)::int FROM usage_daily_facts) AS facts,(SELECT count(*)::int FROM usage_daily_snapshots) AS snapshots")).rows[0]).toEqual({ jobs: 0, facts: 0, snapshots: 0 });
  } finally { await f.close(); }
}, 30000);

sqlTest("disabling analytics preserves queued work and existing snapshots until an explicit re-enable", async () => {
  const f = await createIsolatedPostgres(), db = f.db;
  try {
    const user = randomUUID();
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'resume','Resume','super_admin',false)", [user]);
    await db.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    const first = await queueUsageRollup(db, request(), user);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, first.jobId)).status).toBe("completed");
    const snapshots = (await db.query("SELECT * FROM usage_daily_snapshots")).rows;
    const nextRequest = request();
    const next = await queueUsageRollup(db, nextRequest, user);
    await db.query("UPDATE usage_rollup_state SET processing_enabled=false WHERE singleton=true");
    await db.query("CREATE FUNCTION fixture_deny_rollup_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disabled lookup attempted a write'; END $$");
    await db.query("CREATE TRIGGER fixture_deny_rollup_write BEFORE INSERT OR UPDATE OR DELETE ON usage_rollup_jobs FOR EACH ROW EXECUTE FUNCTION fixture_deny_rollup_write()");
    expect(await queueUsageRollup(db, nextRequest, user)).toEqual(next);
    await expect(queueUsageRollup(db, { ...nextRequest, toDay: "2026-09-02" }, user)).rejects.toMatchObject({ code: "USAGE_ROLLUP_KEY_CONFLICT", status: 409 });
    expect(await processUsageRollups(db, 1)).toEqual([{ status: "idle" }]);
    expect(await getUsageRollupJob(db, next.jobId)).toEqual(next);
    expect((await db.query("SELECT * FROM usage_daily_snapshots")).rows).toEqual(snapshots);
    await db.query("DROP TRIGGER fixture_deny_rollup_write ON usage_rollup_jobs");
    await db.query("DROP FUNCTION fixture_deny_rollup_write()");
    await db.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
    expect((await getUsageRollupJob(db, next.jobId)).status).toBe("completed");
  } finally { await f.close(); }
}, 30000);
