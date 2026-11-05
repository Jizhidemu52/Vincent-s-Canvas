import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import type { Database } from "../../src/db";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import {
  usageV2Overview, usageV2People, usageV2Profile, usageV2Boards,
  usageV2Models, usageV2Quality, usageV2Flows, usageV2QuerySchema, usageV2SqlFilter,
} from "../../src/usage-analytics-v2";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
import { readUsageDailyEventFacts, usageFactCount } from "../../src/usage-event-aggregation";
import { usageDailyFactsCte } from "../../src/usage-rollup-reader";
import { queueUsageRollup, processUsageRollups } from "../../src/usage-rollups";

const realPostgres = process.env.RUN_INTEGRATION_TESTS === "true";
const sqlTest = process.env.PGLITE_RUNTIME_PATH || realPostgres ? test : test.skip;
async function createFixture() {
  if (!realPostgres) return createIsolatedPostgres({ usageRollupsEnabled: true });
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || process.env.NODE_ENV !== "test") throw new Error("Explicit test PostgreSQL URL and NODE_ENV=test are required");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname)) throw new Error("Usage aggregation regression only permits disposable localhost PostgreSQL");
  const schema = `usage_event_read_test_${randomUUID().replaceAll("-", "")}`;
  const control = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let pool: Pool | undefined, created = false;
  const close = async () => {
    await pool?.end();
    try { if (created && /^usage_event_read_test_[0-9a-f]{32}$/.test(schema)) await control.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await control.end(); }
  };
  try {
    const version = Number((await control.query("SHOW server_version_num")).rows[0].server_version_num);
    if (version < 170000) throw new Error("PostgreSQL 17 or newer is required for this target regression");
    await control.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await control.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, options: `-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=1000` });
    const migrations = new URL("../../src/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(name, migrations), "utf8"));
    await pool.query("UPDATE usage_rollup_state SET processing_enabled=true WHERE singleton=true");
    return { db: pool, close };
  } catch (error) { await close(); throw error; }
}
const daily = { source: "daily" as const };
const scope: UsageV2Scope = {
  from: "2026-10-07T00:00:00+08:00", to: "2026-11-06T00:00:00+08:00",
  timezone: "Asia/Shanghai", compare: "previous_period", departmentBasis: "at_event",
};
function clock(db: Database): Database {
  return {
    query: db.query.bind(db),
    connect: async () => {
      const client = await db.connect();
      return {
        query: (sql: string, values?: unknown[]) => sql === "SELECT transaction_timestamp() AS snapshot_at"
          ? Promise.resolve({ rows: [{ snapshot_at: "2026-11-05T04:00:00Z" }], rowCount: 1 })
          : client.query(sql, values),
        release: () => client.release(),
      };
    },
  } as Database;
}

// Mirrors the already-deployed projection: small, normal event payloads, not a
// giant synthetic field. The 30+30-day scope exceeds 32 MiB only in aggregate.
async function largeHistory() {
  const fixture = await createFixture(), db = fixture.db;
  const users = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const oldDepartment = randomUUID(), currentDepartment = randomUUID();
  await db.query("INSERT INTO departments(id,name,code) VALUES($1,'Old','old'),($2,'Current','current')", [oldDepartment, currentDepartment]);
  for (const [index, id] of users.entries()) await db.query("INSERT INTO users(id,username,display_name,role,must_change_password,department_id) VALUES($1,$2::text,$2::text,'designer',false,$3)", [id, `person-${index}`, currentDepartment]);
  await db.query("UPDATE usage_rollup_state SET history_from='2026-09-07'");
  await db.query("DELETE FROM usage_dirty_days");
  await db.query(`INSERT INTO usage_daily_snapshots(day,metric_version,computed_at,fact_count,fact_bytes)
    SELECT day,'existing-facts-v2.2','2026-11-05T00:00:00Z',0,0
    FROM generate_series('2026-09-07'::date,'2026-11-04'::date,interval '1 day') day`);
  await db.query(`WITH source AS (
    SELECT gen_random_uuid()::text AS id,$1::uuid[] AS people,i,
      CASE WHEN i<=90000 THEN '2026-10-07'::date+(i%29)::int ELSE '2026-09-07'::date+(i%30)::int END AS day
    FROM generate_series(1,96000) i
  ), rows AS (
    SELECT id,people[1+(i%3)] AS user_id,day,
      CASE WHEN i%10=0 THEN 'gap' WHEN i%3=0 THEN 'submit' ELSE 'visit' END AS action,
      CASE WHEN i%10=0 THEN 'collection-gap' WHEN i%3=0 THEN 'image-generate' ELSE NULL END AS control_key,
      jsonb_build_object('size',(1+i/522)::text||'x'||(1+i/522)::text) ||
        CASE WHEN i%10=0 THEN '{"droppedEventCount":2}'::jsonb ELSE '{}'::jsonb END AS parameters,
      (day::timestamp AT TIME ZONE 'Asia/Shanghai')+interval '9 hours'+(i%3600)*interval '1 second' AS occurred_at
    FROM source
  ) INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,event_department_id,board_key,model_config_id,operation_type,occurred_at,payload)
    SELECT day,'event',id,user_id,NULL,'image',NULL,NULL,occurred_at,
      jsonb_build_object('id',id,'user_id',user_id,'kind','event','board_key','image','model_config_id',NULL,
        'operation_type',NULL,'action',action,'control_key',control_key,'status','recorded','occurred_at',occurred_at,
        'started_at',NULL,'completed_at',NULL,'parameters',parameters,
        'result_urls','[]'::jsonb,'booked',NULL,'failure_reason',NULL,'failure_category','unknown','attempts',0,
        'optimized',false,'compilation_id',NULL,'batch_linked',NULL,'source_count',NULL,'total_ms',NULL,
        'wait_ms',NULL,'run_ms',NULL,'outputs','[]'::jsonb)
    FROM rows`, [users.slice(0, 3)]);
  for (const [index, duration] of [10, 20, 1000].entries()) {
    const id = randomUUID(), at = `2026-10-${String(10 + index).padStart(2, "0")}T02:00:00Z`;
    const user = users[index % 2]!;
    const payload = {
      id, user_id: user, kind: "task", board_key: "image", model_config_id: null,
      operation_type: "image_generation", action: "image_generation", control_key: null, status: "success",
      occurred_at: at, started_at: at, completed_at: new Date(Date.parse(at) + duration).toISOString(),
      parameters: { quality: "high" }, result_urls: [], booked: index === 2 ? null : index === 0 ? "0.100001" : "0.200002",
      failure_reason: null, failure_category: "unknown", attempts: 0, optimized: false, compilation_id: null,
      batch_linked: index === 1, source_count: index, total_ms: duration, wait_ms: 0, run_ms: duration,
      outputs: index === 2 ? [] : [{ key: `${id}:0`, linked: index === 0, events: index === 0 ? [{ type: "asset.adopted", evidence: "server_confirmed" }] : [] }],
    };
    await db.query("INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,event_department_id,board_key,model_config_id,operation_type,occurred_at,payload) VALUES(($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,'task',$1,$2,$3,'image',NULL,'image_generation',$5,$4)", [id, user, oldDepartment, JSON.stringify(payload), at]);
  }
  const chatId = randomUUID();
  await db.query(`INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,board_key,operation_type,occurred_at,payload)
    VALUES('2026-10-09','chat',$1,$2,'image','chat','2026-10-09T02:00:00Z',
    jsonb_build_object('id',$1::text,'user_id',$2::uuid,'kind','chat','board_key','image','operation_type','chat',
      'model_config_id',NULL,'action','chat','control_key',NULL,'status','success','occurred_at','2026-10-09T02:00:00Z',
      'started_at',NULL,'completed_at',NULL,'parameters','{}'::jsonb,'result_urls','[]'::jsonb,'booked',NULL,
      'failure_reason',NULL,'failure_category','unknown','attempts',0,'optimized',false,'compilation_id',NULL,'outputs','[]'::jsonb))`, [chatId, users[0]]);
  await db.query("INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'image','visit','{}','2026-11-05T03:59:59Z')", [randomUUID(), users[0]]);
  // The only source write is today, which this reader intentionally handles live.
  await db.query("DELETE FROM usage_source_invalidations");
  return { ...fixture, db: clock(db), users, oldDepartment, currentDepartment };
}

sqlTest("30+30 days of normal small events retain all six page contracts without transferring all event facts", async () => {
  const f = await largeHistory();
  try {
    const rawBudget = (await f.db.query("SELECT sum(octet_length((payload||jsonb_build_object('department_id',event_department_id))::text))::text AS bytes,max(octet_length(payload::text)) AS largest FROM usage_daily_facts")).rows[0];
    expect(Number(rawBudget.bytes)).toBeGreaterThan(32 * 1024 * 1024);
    expect(Number(rawBudget.largest)).toBeLessThan(2000);
    const historical = usageV2SqlFilter({ ...scope, from: "2026-09-07T00:00:00+08:00", to: "2026-11-05T00:00:00+08:00", compare: "none" });
    const client = await f.db.connect();
    try {
      const grouped = await readUsageDailyEventFacts(client, { source: "daily", cte: usageDailyFactsCte, where: historical.where, values: historical.values }, historical.departmentColumn, 32 * 1024 * 1024);
      const groupedEvents = grouped.facts.filter(fact => fact.kind === "event");
      expect(groupedEvents.length).toBeGreaterThan(20000);
      expect(groupedEvents.length).toBeLessThan(30000);
      expect(usageFactCount(groupedEvents)).toBe(96000);
    } finally { client.release(); }
    const overview = await usageV2Overview(f.db, scope, daily);
    expect(overview.metrics.visits.value).toBe(54001);
    expect(overview.metrics.interactions.value).toBe(27000);
    expect(overview.metrics.visits.comparison?.value).toBe(3600);
    expect(overview.metrics.activePeople.value).toBe(3);
    expect(overview.metrics.activeDays.value).toBe(88);
    expect(overview.metrics.chatRequests.value).toBe(1);
    expect(overview.metrics.generationRequests.value).toBe(3);
    expect(overview.metrics.generationBookedCny).toMatchObject({ amount: "0.300003", state: "partial", availableCount: 2, missingCount: 1 });
    expect(overview.metrics.totalMsP50.value).toBe(20);
    expect(overview.metrics.totalMsP90.value).toBe(804);
    expect(overview.meta.coverage.find(row => row.metric === "reportedCollectionGaps")).toMatchObject({ eligible: 18000, unknown: 18000 });
    expect(overview.hourlyHeatmap.reduce((sum, row) => sum + row.count, 0)).toBe(81005);
    expect(overview.controlDaily?.series[0]?.total).toBe(27000);
    const query = usageV2QuerySchema.parse({ page: 1, pageSize: 2, sort: "lastActivity", order: "desc" });
    const people = await usageV2People(f.db, scope, query, daily);
    expect(people.pagination.total).toBe(4);
    expect(people.people[0]?.userId).toBe(f.users[0]);
    expect(people.people[0]?.lastActivityAt).toBe("2026-11-05T03:59:59.000Z");
    const boards = await usageV2Boards(f.db, scope, daily);
    expect(boards.boards[0]?.metrics.visits.value).toBe(54001);
    expect(boards.controlUsage[0]).toMatchObject({ users: 1, eligibleUsers: 3 });
    const models = await usageV2Models(f.db, scope, daily);
    expect(models.meta.coverage.find(row => row.metric === "generationRequests")?.eligible).toBe(3);
    const quality = await usageV2Quality(f.db, scope, daily);
    expect(quality.resultUse).toMatchObject({ generatedImages: 2, linkedImages: 1, usedImages: 1, formallyAdoptedImages: 1 });
    expect(quality.metrics.formalAdoptionRate.comparison?.absoluteDelta).toBeNull();
    const flows = await usageV2Flows(f.db, scope, daily);
    expect(flows.pathCoverage).toMatchObject({ state: "unavailable", availableCount: 0, missingCount: 90005 });
    const profile = await usageV2Profile(f.db, scope, f.users[0]!, { ...query, page: 2, pageSize: 7 }, daily);
    const expected = (await f.db.query(`SELECT 'event:'||fact_id AS id,occurred_at FROM usage_daily_facts
      WHERE kind='event' AND user_id=$1 AND occurred_at >= $2 AND occurred_at < '2026-11-05T00:00:00+08:00'
        AND payload->>'action'<>'gap' ORDER BY occurred_at DESC,fact_id LIMIT 7 OFFSET 6`, [f.users[0], scope.from])).rows;
    expect(profile.activityPage.records.map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(profile.activityPage.pagination.total).toBe(27004);
    const atEvent = await usageV2Overview(f.db, { ...scope, departmentIds: [f.oldDepartment] }, daily);
    expect(atEvent.metrics.visits.value).toBe(0);
    expect(atEvent.metrics.generationRequests.value).toBe(3);
    const current = await usageV2Overview(f.db, { ...scope, departmentBasis: "current", departmentIds: [f.currentDepartment] }, daily);
    expect(current.metrics).toEqual(overview.metrics);
  } finally { await f.close(); }
}, 240000);

sqlTest("event grouping preserves parameters, Beijing hour/day, arbitrary boundaries, gaps and original paginated identities", async () => {
  const f = await createFixture(), user = randomUUID(), other = randomUUID();
  try {
    await f.db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'first','First','designer',false),($2,'other','Other','designer',false)", [user, other]);
    const events: Array<{ event_id: string; user_id: string; action: string; control_key: string | null; parameters: object; occurred_at: string }> = [];
    const add = (count: number, at: string, action = "visit", parameters: object = { quality: "high" }, control_key: string | null = null, user_id = user) => {
      for (let index = 0; index < count; index++) events.push({ event_id: randomUUID(), user_id, action, control_key, parameters, occurred_at: new Date(Date.parse(at) + index * 1000).toISOString() });
    };
    add(100, "2026-11-03T01:00:00Z");
    add(2, "2026-11-03T01:10:00Z", "visit", { quality: "low" });
    add(1, "2026-11-03T02:00:00Z");
    add(1, "2026-11-04T01:00:00Z");
    add(3, "2026-11-03T01:20:00Z", "gap", { droppedEventCount: 2 }, "collection-gap");
    add(2, "2026-11-03T01:20:10Z", "gap", { droppedEventCount: 5 }, "collection-gap");
    add(1, "2026-11-03T01:25:00Z", "submit", {}, null);
    add(5, "2026-11-03T01:25:00Z", "submit", {}, "submit");
    add(2, "2026-11-03T01:00:00Z", "visit", { quality: "high" }, null, other);
    await f.db.query(`INSERT INTO usage_events(event_id,user_id,board_key,action,control_key,parameters,occurred_at)
      SELECT event_id,user_id,'image',action,control_key,parameters,occurred_at FROM jsonb_to_recordset($1::jsonb)
      AS r(event_id uuid,user_id uuid,action text,control_key text,parameters jsonb,occurred_at timestamptz)`, [JSON.stringify(events)]);
    await queueUsageRollup(f.db, { fromDay: "2026-11-03", toDay: "2026-11-04", idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(f.db, 2)).every(step => step.status === "processed")).toBe(true);
    const persisted = (await f.db.query("SELECT count(*)::int AS rows,count(*) FILTER(WHERE payload?'eventWeight')::int AS weighted FROM usage_daily_facts")).rows[0];
    expect(persisted).toEqual({ rows: events.length, weighted: 0 });
    expect(Number((await f.db.query("SELECT sum(fact_count)::text AS n FROM usage_daily_snapshots")).rows[0].n)).toBe(events.length);
    const selected = { ...scope, from: "2026-11-03T00:00:00+08:00", to: "2026-11-05T00:00:00+08:00", compare: "none" as const };
    const filter = usageV2SqlFilter(selected), client = await f.db.connect();
    let compressed;
    try { compressed = await readUsageDailyEventFacts(client, { source: "daily", cte: usageDailyFactsCte, where: filter.where, values: filter.values }, filter.departmentColumn, 32 * 1024 * 1024); }
    finally { client.release(); }
    expect(usageFactCount(compressed.facts)).toBe(events.length);
    expect(compressed.facts).toHaveLength(9);
    expect(compressed.facts.find(fact => fact.eventWeight === 100)).toMatchObject({ parameters: { quality: "high" }, occurred_at: "2026-11-03T01:01:39+00:00" });
    expect(compressed.facts.filter(fact => fact.action === "gap").map(fact => [fact.parameters.droppedEventCount, fact.eventWeight]).sort()).toEqual([[2, 3], [5, 2]]);
    const db = clock(f.db);
    const live = await usageV2Overview(db, selected), result = await usageV2Overview(db, selected, daily);
    expect(result.metrics).toEqual(live.metrics);
    expect(result.daily).toEqual(live.daily);
    expect(result.hourlyHeatmap).toEqual(live.hourlyHeatmap);
    expect(result.controlDaily).toEqual(live.controlDaily);
    expect(result.controlDaily?.missingControlRecords).toBe(1);
    expect(result.meta.coverage).toEqual(live.meta.coverage);
    expect(result.insights).toEqual(live.insights);
    const partial = { ...selected, from: "2026-11-03T01:00:30Z", to: "2026-11-03T01:01:00Z" };
    expect((await usageV2Overview(db, partial, daily)).metrics.visits.value).toBe(30);
    const query = usageV2QuerySchema.parse({ page: 1, pageSize: 7 });
    const raw = (await f.db.query("SELECT 'event:'||id AS id,occurred_at FROM usage_events WHERE user_id=$1 AND action<>'gap' ORDER BY occurred_at DESC,id::text COLLATE \"C\"", [user])).rows;
    const received: string[] = [];
    for (let page = 1; page <= Math.ceil(raw.length / 7); page++) {
      const profile = await usageV2Profile(db, selected, user, { ...query, page }, daily);
      const ids = profile.activityPage.records.map(row => row.id);
      expect(ids).toEqual(raw.slice((page - 1) * 7, page * 7).map(row => row.id));
      expect(profile.activityPage.pagination.total).toBe(raw.length);
      expect(profile.activityPage.records.every(row => !Object.hasOwn(row, "eventWeight"))).toBe(true);
      received.push(...ids);
    }
    expect(new Set(received).size).toBe(raw.length);
    expect((await usageV2Profile(db, selected, user, { ...query, page: 100 }, daily)).activityPage).toMatchObject({ records: [], pagination: { total: raw.length } });
  } finally { await f.close(); }
}, 120000);

sqlTest("expanded result exactly at 32MiB is accepted, one byte over and a single oversized source fact are rejected before facts transfer", async () => {
  const f = await createFixture(), user = randomUUID(), first = randomUUID(), second = randomUUID();
  const maximum = 32 * 1024 * 1024;
  try {
    await f.db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'budget','Budget','designer',false)", [user]);
    for (const id of [first, second]) await f.db.query(`INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,occurred_at,payload)
      VALUES('2026-11-03','event',$1,$2,'2026-11-03T01:00:00Z',
        jsonb_build_object('id',$1::text,'user_id',$2::uuid,'kind','event','occurred_at','2026-11-03T01:00:00+00:00',
          'outputs','[]'::jsonb,'action','visit','parameters',jsonb_build_object('fixtureGroup',$1::text),'fixturePadding',''))`, [id, user]);
    const selected = { ...scope, from: "2026-11-03T00:00:00+08:00", to: "2026-11-04T00:00:00+08:00", compare: "none" as const };
    const filter = usageV2SqlFilter(selected);
    let transferredFacts = 0;
    const read = async () => {
      const client = await f.db.connect();
      try {
        return await readUsageDailyEventFacts({ query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          transferredFacts += result.rows[0]?.facts?.length ?? 0;
          return result;
        } } as Parameters<typeof readUsageDailyEventFacts>[0], { source: "daily", cte: usageDailyFactsCte, where: filter.where, values: filter.values }, filter.departmentColumn, maximum);
      } finally { client.release(); }
    };
    const baseline = await read();
    await f.db.query("UPDATE usage_daily_facts SET payload=jsonb_set(payload,'{fixturePadding}',to_jsonb(repeat('x',$2::int))) WHERE fact_id=$1", [first, maximum - baseline.bytes]);
    const exact = await read();
    expect(exact.bytes).toBe(maximum);
    expect(exact.facts).toHaveLength(2);
    const before = transferredFacts;
    await f.db.query("UPDATE usage_daily_facts SET payload=jsonb_set(payload,'{fixturePadding}',to_jsonb((payload->>'fixturePadding')||'x')) WHERE fact_id=$1", [first]);
    await expect(read()).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
    expect(transferredFacts).toBe(before);
    await f.db.query("UPDATE usage_daily_facts SET payload=jsonb_set(payload,'{fixturePadding}',to_jsonb(repeat('x',$2::int))) WHERE fact_id=$1", [first, maximum + 1]);
    await expect(read()).rejects.toMatchObject({ code: "USAGE_SCOPE_TOO_LARGE", status: 422 });
    expect(transferredFacts).toBe(before);
  } finally { await f.close(); }
}, 120000);
