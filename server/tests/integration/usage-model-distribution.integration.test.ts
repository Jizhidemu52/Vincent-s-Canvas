import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usageV2Models } from "../../src/usage-analytics-v2";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";
const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;

sqlTest("model distribution, cost dimension and failure categories survive daily projection with exact filters", async () => {
  const f = await createIsolatedPostgres(), db = f.db, user = randomUUID(), provider = randomUUID(), model = randomUUID();
  try {
    await db.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'box-fixture','Fixture','super_admin',false)", [user]);
    await db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Fixture','openai','https://never-called.invalid','unused')", [provider]);
    await db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Test model','fixture',ARRAY['generate'])", [model, provider]);
    for (const [i, duration] of [10, 20, 30, 1000, null, -1, -2].entries()) {
      const id = randomUUID(), at = i === 3 ? "2026-09-02T02:00:00Z" : "2026-09-01T02:00:00Z", status = duration === -1 ? "failed" : duration === -2 ? "cancelled" : "success";
      await db.query("INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,queued_at,completed_at,failure_reason) VALUES($1,$1::uuid::text,$2,'fixture','image_generation',$3,'SECRET prompt','{}','image',$4,$5,$6,'timeout SECRET vendor detail')", [id, user, model, status, at, duration === null || duration < 0 ? null : new Date(Date.parse(at) + duration).toISOString()]);
      if (status === "success") await db.query("INSERT INTO generation_history(task_id,user_id,project_id,operation_type,model_config_id,prompt,source_urls,result_urls,credits,rmb_cost,status) VALUES($1,$2,'fixture','image_generation',$3,'SECRET history','[]','[]',0,0.100001,'success')", [id, user, model]);
    }
    const scope: UsageV2Scope = { from: "2026-09-01T00:00:00+08:00", to: "2026-09-03T00:00:00+08:00", compare: "none", timezone: "Asia/Shanghai", departmentBasis: "at_event", userIds: [user], modelConfigIds: [model], operationTypes: ["image_generation"], boardKeys: ["image"] };
    const live = await usageV2Models(db, scope);
    expect(live.models).toHaveLength(1);
    expect(live.models[0]?.latency).toMatchObject({ eligible: 5, available: 4, missing: 1, min: 10, q1: 17.5, median: 25, q3: 272.5, max: 1000 });
    expect(live.models[0]?.failures).toEqual([{ category: "provider_timeout", label: "供应商超时", count: 1 }]);
    expect(live.costBreakdown.models).toHaveLength(1);
    expect(live.costBreakdown.models[0]).toMatchObject({ key: model, metrics: { generationBookedCny: { amount: "0.500005" } } });
    expect(JSON.stringify(live)).not.toContain("SECRET");
    await queueUsageRollup(db, { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() }, user);
    expect((await processUsageRollups(db, 2)).every((row) => row.status === "processed")).toBe(true);
    const daily = await usageV2Models(db, scope, { source: "daily" });
    expect(daily.models).toEqual(live.models);
    expect(daily.costBreakdown.models).toEqual(live.costBreakdown.models);
    const selectedDay = await usageV2Models(db, { ...scope, to: "2026-09-02T00:00:00+08:00" }, { source: "daily" });
    expect(selectedDay.models[0]?.latency).toMatchObject({ available: 3, median: 20, max: 30 });
    const empty = await usageV2Models(db, { ...scope, boardKeys: ["video"] }, { source: "daily" });
    expect(empty.models).toEqual([]);
    expect(empty.costBreakdown.models).toEqual([]);
  } finally { await f.close(); }
}, 120000);
