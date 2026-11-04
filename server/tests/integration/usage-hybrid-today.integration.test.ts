import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/db";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usageV2Overview, usageV2Quality } from "../../src/usage-analytics-v2";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const today: UsageV2Scope = { from: "2026-09-03T00:00:00+08:00", to: "2026-09-04T00:00:00+08:00", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "at_event" };
const daily = { source: "daily" as const };

// Only the transaction clock is controlled. All reads, writes, projections,
// triggers and aggregation execute against disposable PostgreSQL.
function observedAt(db: Database, getTime: () => string): Database {
  return {
    query: db.query.bind(db),
    connect: async () => {
      const client = await db.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          return sql === "SELECT transaction_timestamp() AS snapshot_at"
            ? { ...result, rows: [{ snapshot_at: getTime() }] }
            : result;
        },
        release: () => client.release(),
      };
    },
  } as unknown as Database;
}
async function setup() {
  const fixture = await createIsolatedPostgres(), db = fixture.db;
  const user = randomUUID(), department = randomUUID(), model = randomUUID(), provider = randomUUID();
  await db.query("INSERT INTO departments(id,name,code) VALUES($1,'Fixture','fixture')", [department]);
  await db.query("INSERT INTO users(id,username,display_name,role,must_change_password,department_id) VALUES($1,'fixture','Fixture','super_admin',false,$2)", [user, department]);
  await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Fixture','openai','https://never-called.invalid','unused')", [provider]);
  await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Model','fixture-model',ARRAY['generate'])", [model, provider]);
  const event = (at: string) => db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}',$3)", [randomUUID(), user, at]);
  const image = async (at: string, cost: string, action: string) => {
    const task = randomUUID(), asset = randomUUID();
    await db.query("INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'SECRET','{}','image','success',$5,$6,$6,$7)", [task, user, department, model, JSON.stringify([`/api/assets/${asset}/content`]), at, new Date(Date.parse(at) + 100).toISOString()]);
    await db.query("INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1", [task, cost]);
    await db.query("INSERT INTO assets(id,owner_user_id,department_id,task_id,object_key,filename,mime_type,kind,status,metadata) VALUES($1,$2,$3,$4,$1::uuid::text,'SECRET.png','image/png','image','ready','{}')", [asset, user, department, task]);
    await db.query("INSERT INTO asset_events(id,asset_id,designer_user_id,actor_user_id,task_id,event_type,idempotency_key,occurred_at) VALUES($1,$2,$3,$3,$4,$5,$1::uuid::text,$6)", [randomUUID(), asset, user, task, action, new Date(Date.parse(at) + 1000).toISOString()]);
  };
  const refresh = async (fromDay: string, toDay = fromDay) => {
    await queueUsageRollup(db, { fromDay, toDay, idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
  };
  return { ...fixture, db, user, department, model, event, image, refresh };
}

sqlTest("today-only reads new source records immediately without a rollup or any GET writes", async () => {
  const f = await setup(), db = observedAt(f.db, () => "2026-09-03T04:00:00Z");
  try {
    await f.event("2026-09-03T01:00:00Z");
    const before = (await f.db.query("SELECT * FROM usage_dirty_days ORDER BY day")).rows;
    const marker = f.statements.length;
    const first = await usageV2Overview(db, today, daily);
    expect(first.metrics.visits.value).toBe(1);
    expect(first.meta).toMatchObject({ dataMode: "daily_history_live_today", liveFrom: "2026-09-02T16:00:00.000Z", asOf: "2026-09-03T04:00:00.000Z", computedThrough: "2026-09-03T04:00:00.000Z", lagSeconds: 0 });
    expect(first.meta.snapshot).toBeUndefined();
    expect(f.statements.slice(marker).every(sql => /^(SELECT|WITH|BEGIN|SET|COMMIT)/.test(sql))).toBe(true);
    expect((await f.db.query("SELECT * FROM usage_dirty_days ORDER BY day")).rows).toEqual(before);
    await f.event("2026-09-03T02:00:00Z");
    expect((await usageV2Overview(db, today, daily)).metrics.visits.value).toBe(2);
    expect((await f.db.query("SELECT (SELECT count(*)::int FROM usage_daily_snapshots) AS snapshots,(SELECT count(*)::int FROM usage_rollup_jobs) AS jobs")).rows[0]).toEqual({ snapshots: 0, jobs: 0 });
  } finally { await f.close(); }
}, 120000);

sqlTest("history and live today keep exact image evidence, compound filters and comparison without overlapping the boundary", async () => {
  const f = await setup(), db = observedAt(f.db, () => "2026-09-03T04:00:00Z");
  try {
    await f.image("2026-09-02T01:00:00Z", "0.100001", "asset.adopted");
    await f.event("2026-09-02T15:59:59.999Z");
    await f.event("2026-09-02T16:00:00.000Z");
    await f.image("2026-09-03T01:00:00Z", "0.200002", "asset.exported");
    await f.refresh("2026-09-02");
    const scope = { ...today, from: "2026-09-02T00:00:00+08:00" };
    const quality = await usageV2Quality(db, scope, daily);
    expect(quality.metrics.generationRequests.value).toBe(2);
    expect(quality.metrics.generationBookedCny.amount).toBe("0.300003");
    expect(quality.resultUse).toMatchObject({ generatedImages: 2, usedImages: 2, formallyAdoptedImages: 1 });
    expect(quality.metrics.totalMsP50.value).toBe(100);
    expect(quality.meta.snapshot).toMatchObject({ dayCount: 1 });
    expect(quality.meta.dataMode).toBe("daily_history_live_today");
    expect(quality.meta.asOf).toBe("2026-09-03T04:00:00.000Z");
    const overview = await usageV2Overview(db, scope, daily);
    expect(overview.metrics.visits.value).toBe(2);
    expect(overview.daily.map(row => row.metrics.visits.value)).toEqual([1, 1]);
    const filtered = await usageV2Overview(db, { ...scope, userIds: [f.user], departmentIds: [f.department], boardKeys: ["image"], modelConfigIds: [f.model], operationTypes: ["image_generation"] }, daily);
    expect(filtered.metrics.generationRequests.value).toBe(2);
    expect(filtered.metrics.visits.value).toBe(0);
    const compared = await usageV2Overview(db, { ...today, compare: "previous_period" }, daily);
    expect(compared.metrics.generationRequests).toMatchObject({ value: 1, comparison: { value: 1, absoluteDelta: 0 } });
    expect(compared.metrics.visits).toMatchObject({ value: 1, comparison: { value: 1, absoluteDelta: 0 } });
    expect(compared.meta.snapshot?.dayCount).toBe(1);
    await f.event("2026-09-02T02:00:00Z");
    await f.db.query("UPDATE usage_dirty_days SET ready_after='2026-09-02T00:00:00Z' WHERE day='2026-09-02'");
    await expect(usageV2Overview(db, { ...today, from: scope.from, to: today.from }, daily)).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
    await expect(usageV2Overview(db, scope, daily)).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
  } finally { await f.close(); }
}, 120000);

sqlTest("both current and comparison intervals inside today read live with one shared transaction cutoff", async () => {
  const f = await setup(), db = observedAt(f.db, () => "2026-09-03T08:00:00Z");
  try {
    await f.event("2026-09-03T01:00:00Z");
    await f.event("2026-09-03T05:00:00Z");
    await f.event("2026-09-03T06:00:00Z");
    const result = await usageV2Overview(db, { ...today, from: "2026-09-03T04:00:00Z", to: "2026-09-03T08:00:00Z", compare: "previous_period" }, daily);
    expect(result.metrics.visits).toMatchObject({ value: 2, comparison: { value: 1, absoluteDelta: 1 } });
    expect(result.meta.snapshot).toBeUndefined();
    expect(result.meta.asOf).toBe("2026-09-03T08:00:00.000Z");
  } finally { await f.close(); }
}, 120000);

sqlTest("Beijing midnight changes yesterday from live to required daily facts and keeps the new day live", async () => {
  const f = await setup();
  let time = "2026-09-03T15:59:59Z";
  const db = observedAt(f.db, () => time);
  try {
    await f.event("2026-09-03T15:59:58Z");
    expect((await usageV2Overview(db, today, daily)).metrics.visits.value).toBe(1);
    time = "2026-09-03T16:00:01Z";
    await expect(usageV2Overview(db, today, daily)).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
    await f.event("2026-09-03T16:00:00Z");
    const next = await usageV2Overview(db, { ...today, from: "2026-09-04T00:00:00+08:00", to: "2026-09-05T00:00:00+08:00" }, daily);
    expect(next.metrics.visits.value).toBe(1);
    expect(next.meta).toMatchObject({ dataMode: "daily_history_live_today", liveFrom: "2026-09-03T16:00:00.000Z", asOf: "2026-09-03T16:00:01.000Z" });
    await f.refresh("2026-09-03");
    const historical = await usageV2Overview(db, today, daily);
    expect(historical.metrics.visits.value).toBe(1);
    expect(historical.meta).toMatchObject({ dataMode: "persisted_daily_facts", snapshot: { dayCount: 1 } });
    expect(historical.meta.liveFrom).toBeUndefined();
  } finally { await f.close(); }
}, 120000);

sqlTest("the shared live row budget includes today's current and comparison intervals", async () => {
  const f = await setup(), db = observedAt(f.db, () => "2026-09-03T08:00:00Z");
  try {
    await f.db.query(`INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at)
      SELECT gen_random_uuid(),$1,'image','visit','{}',CASE WHEN i<=25000 THEN '2026-09-03T01:00:00Z'::timestamptz ELSE '2026-09-03T05:00:00Z'::timestamptz END
      FROM generate_series(1,50001) i`, [f.user]);
    await expect(usageV2Overview(db, { ...today, from: "2026-09-03T04:00:00Z", to: "2026-09-03T08:00:00Z", compare: "previous_period" }, daily)).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
    expect((await f.db.query("SELECT count(*)::int AS n FROM usage_daily_snapshots")).rows[0].n).toBe(0);
  } finally { await f.close(); }
}, 180000);

sqlTest("the decoded byte budget is shared by persisted history and today's live rows", async () => {
  const f = await setup(), db = observedAt(f.db, () => "2026-09-03T04:00:00Z");
  try {
    await f.event("2026-09-02T01:00:00Z");
    await f.refresh("2026-09-02");
    // Two individually valid projections must not each receive a 32 MiB budget.
    await f.db.query("UPDATE usage_daily_facts SET payload=payload||jsonb_build_object('fixtureOversized',repeat('x',17000000)) WHERE day='2026-09-02'");
    await f.image("2026-09-03T01:00:00Z", "0.100001", "asset.adopted");
    await f.db.query("UPDATE generation_history SET result_urls=jsonb_build_array(repeat('y',17000000))");
    await expect(usageV2Overview(db, { ...today, from: "2026-09-02T00:00:00+08:00" }, daily)).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
  } finally { await f.close(); }
}, 180000);
