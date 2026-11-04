import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usageV2Overview } from "../../src/usage-analytics-v2";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
sqlTest(
    "overview rules read the same filtered daily facts and comparison, never provider errors or prompts",
    async () => {
        const f = await createIsolatedPostgres(),
            db = f.db;
        try {
            const user = randomUUID(),
                provider = randomUUID(),
                model = randomUUID();
            await db.query(
                "INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'rules-user','Fixture','super_admin',false)",
                [user],
            );
            await db.query(
                "INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Fixture','openai','https://never-called.invalid','unused')",
                [provider],
            );
            await db.query(
                "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities) VALUES($1,$2,'Model fixture','rules-fixture',ARRAY['generate'])",
                [model, provider],
            );
            for (const [at, failureCount, gaps] of [
                ["2026-09-01T06:00:00Z", 10, 8],
                ["2026-09-02T06:00:00Z", 50, 20],
            ] as const) {
                await db.query(
                    `INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,queued_at,completed_at,failure_reason)
        SELECT id,id::text,$1,'fixture','image_generation',$2,'SECRET_PROMPT','{}','image',CASE WHEN n<=$3 THEN 'failed' ELSE 'success' END,$4,$4,'SECRET_ERROR'
        FROM (SELECT gen_random_uuid() AS id,n FROM generate_series(1,100) AS n) fixture`,
                    [user, model, failureCount, at],
                );
                await db.query(
                    "INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) SELECT gen_random_uuid(),$1,'canvas','visit','{}',$2 FROM generate_series(1,120)",
                    [user, at],
                );
                await db.query(
                    "INSERT INTO usage_events(event_id,user_id,board_key,action,parameters,occurred_at) VALUES($1,$2,'canvas','gap',jsonb_build_object('droppedEventCount',$3::integer),$4)",
                    [randomUUID(), user, gaps, at],
                );
            }
            await queueUsageRollup(
                db,
                { fromDay: "2026-09-01", toDay: "2026-09-02", idempotencyKey: randomUUID() },
                user,
            );
            expect((await processUsageRollups(db, 2)).every((row) => row.status === "processed")).toBe(true);
            const scope: UsageV2Scope = {
                from: "2026-09-02T00:00:00+08:00",
                to: "2026-09-03T00:00:00+08:00",
                timezone: "Asia/Shanghai",
                compare: "previous_period",
                departmentBasis: "at_event",
                userIds: [user],
            };
            const result = await usageV2Overview(db, scope, { source: "daily" });
            const spike = result.insights.find((row) => row.ruleId === "model-terminal-failure-double-v1")!;
            expect(spike.evidence).toMatchObject({
                currentFailed: 50,
                currentTerminal: 100,
                comparisonFailed: 10,
                comparisonTerminal: 100,
            });
            expect(result.insights.find((row) => row.ruleId === "visits-many-tasks-few-v1")?.evidence).toMatchObject({
                visits: 120,
                generationTasks: 0,
            });
            expect(result.insights.find((row) => row.ruleId === "reported-gap-increase-v1")?.evidence).toMatchObject({
                currentReported: 20,
                comparisonReported: 8,
            });
            expect(result.insights.find((row) => row.ruleId === "recorded-activity-peak-v1")?.evidence).toMatchObject({
                weekdayMondayZero: 2,
                hourBeijing: 14,
            });
            expect(JSON.stringify(result.insights)).not.toMatch(/SECRET_PROMPT|SECRET_ERROR|never-called/);
            const filtered = await usageV2Overview(db, { ...scope, boardKeys: ["canvas"] }, { source: "daily" });
            expect(filtered.insights.some((row) => row.ruleId === "model-terminal-failure-double-v1")).toBe(false);
            expect(filtered.metrics.generationRequests.value).toBe(0);
            const noComparison = await usageV2Overview(db, { ...scope, compare: "none" }, { source: "daily" });
            expect(noComparison.insights.some((row) => /double|gap-increase/.test(row.ruleId))).toBe(false);
        } finally {
            await f.close();
        }
    },
    120000,
);

sqlTest(
    "spend signal requires the selected range to cover the full 30-day baseline and suppresses unknown booked history",
    async () => {
        const f = await createIsolatedPostgres(),
            db = f.db;
        try {
            const user = randomUUID();
            await db.query(
                "INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'spend-user','Fixture','designer',false)",
                [user],
            );
            await db.query(
                `INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,prompt,parameters,tool_key,status,queued_at,completed_at)
      SELECT id,id::text,$1,'fixture','image_generation','SECRET_PROMPT','{}','image','success',
      CASE WHEN n=11 THEN '2026-10-31T06:00:00Z' ELSE '2026-10-01T06:00:00Z' END::timestamptz,
      CASE WHEN n=11 THEN '2026-10-31T06:00:01Z' ELSE '2026-10-01T06:00:01Z' END::timestamptz
      FROM (SELECT gen_random_uuid() AS id,n FROM generate_series(1,11) AS n) fixture`,
                [user],
            );
            await db.query(
                `INSERT INTO generation_history(task_id,user_id,project_id,operation_type,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status)
      SELECT id,user_id,project_id,operation_type,prompt,parameters,source_urls,result_urls,0,'3.000000','success' FROM tasks WHERE user_id=$1`,
                [user],
            );
            const scope: UsageV2Scope = {
                from: "2026-10-01T00:00:00+08:00",
                to: "2026-11-01T00:00:00+08:00",
                timezone: "Asia/Shanghai",
                compare: "none",
                departmentBasis: "at_event",
                userIds: [user],
            };
            const result = await usageV2Overview(db, scope);
            expect(
                result.insights.find((row) => row.ruleId === "personal-booked-day-above-30-day-mean-v1")?.evidence,
            ).toMatchObject({
                targetDay: "2026-10-31",
                baselineFrom: "2026-10-01",
                baselineDays: 30,
                currentBookedCny: "3.000000",
                baselineBookedCny: "30.000000",
            });
            expect(
                (await usageV2Overview(db, { ...scope, from: "2026-10-02T00:00:00+08:00" })).insights.some(
                    (row) => row.ruleId === "personal-booked-day-above-30-day-mean-v1",
                ),
            ).toBe(false);
            await db.query(
                "UPDATE generation_history SET status='failed' WHERE task_id=(SELECT id FROM tasks WHERE user_id=$1 ORDER BY queued_at LIMIT 1)",
                [user],
            );
            expect(
                (await usageV2Overview(db, scope)).insights.some(
                    (row) => row.ruleId === "personal-booked-day-above-30-day-mean-v1",
                ),
            ).toBe(false);
        } finally {
            await f.close();
        }
    },
    120000,
);
