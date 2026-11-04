import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usageV2Boards, usageV2FactsCte, usageV2Profile, usageV2QuerySchema } from "../../src/usage-analytics-v2";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const scope: UsageV2Scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "at_event" };
const query = usageV2QuerySchema.parse({});
async function setup(withTasks = true) {
  const f = await createIsolatedPostgres(), db = f.db, user = randomUUID(), batch = randomUUID();
  await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'habit-fixture','Habit fixture','super_admin',false)", [user]);
  await db.query("INSERT INTO batch_tasks(id,request_id,user_id,project_id,operation_type,total_items) VALUES($1,$1::uuid::text,$2,'fixture','image_generation',1)", [batch, user]);
  const ids: string[] = [];
  if (withTasks) {
    const rows = [
      { board: "image", operation: "image_generation", batch, optimized: true, sources: ["SECRET-reference", "SECRET-reference"], results: ["SECRET-output"], parameters: { size: "1024x1024", quality: "high", resolution: "2K", aspectRatio: "1:1" } },
      // Multiple results without a batch id must never be called a batch task.
      { board: "image", operation: "image_generation", batch: null, optimized: false, sources: [], results: ["SECRET-a", "SECRET-b", "SECRET-c"], parameters: { size: "1024x1024", quality: "SECRET-invalid-quality", aspectRatio: "2:3" } },
      { board: "canvas-image", operation: "inpaint", batch: null, optimized: false, sources: { malformed: "SECRET" }, results: [], parameters: {} },
      { board: "video", operation: "video_generation", batch: null, optimized: false, sources: ["SECRET-video"], results: [], parameters: { quality: "high", size: "1920x1080" } },
      { board: null, operation: "legacy_unknown", batch: null, optimized: false, sources: ["SECRET-unknown"], results: [], parameters: { quality: "low" } },
    ];
    for (const row of rows) {
      const id = randomUUID(); ids.push(id);
      await db.query("INSERT INTO tasks(id,request_id,user_id,batch_id,project_id,operation_type,tool_key,prompt,parameters,source_urls,result_urls,prompt_optimized,status,queued_at) VALUES($1,$1::uuid::text,$2,$3,'fixture',$4,$5,'SECRET prompt',$6,$7,$8,$9,'success','2026-09-01T01:00:00Z')", [id, user, row.batch, row.operation, row.board, row.parameters, JSON.stringify(row.sources), JSON.stringify(row.results), row.optimized]);
    }
  }
  const refresh = async () => {
    await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-01", idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(db, 1))[0]?.status).toBe("processed");
  };
  return { ...f, user, ids, refresh };
}

sqlTest("profile habits count batch markers, submitted reference items and explicit image operations without inferring work", async () => {
  const f = await setup();
  try {
    const profile = await usageV2Profile(f.db, scope, f.user, query);
    expect(profile.habits.rates.find(row => row.key === "batchLinked")).toMatchObject({ eligible: 5, matched: 1, missing: 0, rate: { value: 0.2, denominator: 5 } });
    expect(profile.habits.rates.find(row => row.key === "optimizedMarked")).toMatchObject({ eligible: 5, matched: 1, missing: 0, rate: { value: 0.2 } });
    const inpaint = profile.habits.rates.find(row => row.key === "inpaint");
    expect(inpaint).toMatchObject({ eligible: 4, matched: 1, missing: 1, rate: { denominator: 3, state: "partial" } });
    expect(inpaint?.rate.value).toBeCloseTo(1 / 3);
    expect(profile.habits.referenceCounts).toMatchObject({ eligible: 3, missing: 1 });
    expect(profile.habits.referenceCounts.items.map(row => ({ value: row.value, count: row.count, rate: row.rate.value }))).toEqual([{ value: 0, count: 1, rate: 0.5 }, { value: 2, count: 1, rate: 0.5 }]);
    expect(JSON.stringify(profile)).not.toContain("SECRET");
    const projected = (await f.db.query(`${usageV2FactsCte} SELECT * FROM facts WHERE id=$1`, [f.ids[0]])).rows[0];
    expect(projected).toMatchObject({ batch_linked: true, source_count: 2 });
    expect(projected).not.toHaveProperty("source_urls");
    expect(projected).not.toHaveProperty("prompt");
  } finally { await f.close(); }
}, 120000);

sqlTest("parameter distributions have independent board denominators and retain entirely missing parameters", async () => {
  const f = await setup();
  try {
    const result = await usageV2Boards(f.db, scope);
    const quality = result.parameters.filter(row => row.parameter === "quality");
    expect(quality.find(row => row.boardKey === "image")).toMatchObject({ value: "high", count: 1, eligible: 2, missing: 1, rate: { value: 1, denominator: 1, state: "partial" } });
    expect(quality.find(row => row.boardKey === "video")).toMatchObject({ value: "high", count: 1, eligible: 1, missing: 0, rate: { value: 1, denominator: 1, state: "available" } });
    expect(quality.find(row => row.boardKey === "canvas-image")).toMatchObject({ value: null, count: 0, eligible: 1, missing: 1, rate: { value: null, state: "unavailable" } });
    expect(result.parameters.find(row => row.boardKey === "video" && row.parameter === "aspectRatio")).toMatchObject({ value: null, missing: 1, rate: { value: null } });
    expect(result.parameters.find(row => row.boardKey === "image" && row.parameter === "size")).toMatchObject({ value: "1024x1024", count: 2, eligible: 2, missing: 0, rate: { value: 1, denominator: 2 } });
    expect(quality.find(row => row.boardKey === "unknown")).toMatchObject({ value: "low", count: 1, boardLabel: "未记录板块" });
    expect(JSON.stringify(result.parameters)).not.toContain("SECRET");
    const filtered = await usageV2Boards(f.db, { ...scope, boardKeys: ["image"] });
    expect(filtered.parameters.every(row => row.boardKey === "image" && row.eligible === 2)).toBe(true);
    expect((await usageV2Profile(f.db, scope, f.user, query)).habits.parameters).toEqual(result.parameters);
  } finally { await f.close(); }
}, 120000);

sqlTest("habits persist exact projections and batch or source changes dirty historical facts before recomputation", async () => {
  const f = await setup();
  try {
    const live = await usageV2Profile(f.db, scope, f.user, query);
    await f.refresh();
    const daily = await usageV2Profile(f.db, scope, f.user, query, { source: "daily" });
    expect(daily.habits).toEqual(live.habits);
    const payload = (await f.db.query("SELECT payload FROM usage_daily_facts WHERE fact_id=$1", [f.ids[0]])).rows[0].payload;
    expect(payload).toMatchObject({ batch_linked: true, source_count: 2 });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
    await f.db.query("UPDATE tasks SET batch_id=NULL,source_urls='[\"SECRET-only-one\"]' WHERE id=$1", [f.ids[0]]);
    await expect(usageV2Profile(f.db, scope, f.user, query, { source: "daily" })).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
    await f.refresh();
    const updated = await usageV2Profile(f.db, scope, f.user, query, { source: "daily" });
    expect(updated.habits.rates.find(row => row.key === "batchLinked")?.matched).toBe(0);
    expect(updated.habits.referenceCounts.items.map(row => row.value)).toEqual([0, 1]);
    await f.db.query("UPDATE usage_daily_snapshots SET metric_version='obsolete-before-habits' WHERE day='2026-09-01'");
    await expect(usageV2Profile(f.db, scope, f.user, query, { source: "daily" })).rejects.toMatchObject({ code: "USAGE_ROLLUP_REFRESH_REQUIRED" });
  } finally { await f.close(); }
}, 120000);

sqlTest("an employee without task records has unavailable habits rather than invented zero proportions", async () => {
  const f = await setup(false);
  try {
    const profile = await usageV2Profile(f.db, scope, f.user, query);
    expect(profile.habits.rates.every(row => row.eligible === 0 && row.matched === 0 && row.rate.value === null && row.rate.state === "unavailable")).toBe(true);
    expect(profile.habits.referenceCounts).toEqual({ eligible: 0, missing: 0, items: [] });
    expect(profile.habits.parameters).toEqual([]);
  } finally { await f.close(); }
}, 120000);
