import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../../src/config";
import type { UsageV2ReportResult } from "../../../shared/usage-report-v2";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { queueUsageRollup, processUsageRollups } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
sqlTest(
    "free report HTTP reads real daily facts with exact scope, audits safely and never calls AI or rewrites facts",
    async () => {
        const fixture = await createIsolatedPostgres({ usageRollupsEnabled: true }),
            db = fixture.db;
        let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
        try {
            const actor = randomUUID(),
                person = randomUUID(),
                outsider = randomUUID(),
                department = randomUUID(),
                currentDepartment = randomUUID(),
                model = randomUUID(),
                provider = randomUUID();
            await db.query(
                "INSERT INTO departments(id,name,code) VALUES($1,'PRIVATE_DEPARTMENT','report-old'),($2,'PRIVATE_CURRENT','report-current')",
                [department, currentDepartment],
            );
            for (const [id, username, role] of [
                [actor, "report-admin", "super_admin"],
                [person, "report-person", "designer"],
                [outsider, "report-outside", "designer"],
            ]) {
                await db.query(
                    "INSERT INTO users(id,username,display_name,role,department_id,must_change_password) VALUES($1,$2,'PRIVATE_NAME Alice',$3,$4,false)",
                    [id, username, role, currentDepartment],
                );
            }
            await db.query(
                "INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'PRIVATE_PROVIDER','openai','https://never-called.invalid','PRIVATE_CREDENTIAL')",
                [provider],
            );
            await db.query(
                "INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'PRIVATE_MODEL','report-model',ARRAY['generate'],999)",
                [model, provider],
            );
            for (const [user, board, cost] of [
                [person, "image", "0.234567"],
                [person, "canvas-image", "5.000000"],
                [outsider, "image", "9.000000"],
            ]) {
                const task = randomUUID();
                await db.query(
                    "INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'PRIVATE_PROMPT','{}',$5,'success','[\"https://private.invalid/PRIVATE_IMAGE.png\"]','2026-10-01T01:00:00Z','2026-10-01T01:00:01Z','2026-10-01T01:00:02Z')",
                    [task, user, department, model, board],
                );
                await db.query(
                    "INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1",
                    [task, cost],
                );
            }
            let modelCalls = 0;
            const app = express();
            app.use(express.json());
            app.use((req, _res, next) => {
                Object.assign(req, { auth: { id: actor, role: "super_admin" } });
                next();
            });
            app.use(
                "/api/admin/usage",
                createAdminUsageRouter(db, {} as AppConfig, {
                    complete: async () => {
                        modelCalls++;
                        throw new Error("must not call model");
                    },
                }),
            );
            server = app.listen(0, "127.0.0.1");
            await new Promise<void>((resolve) => server!.once("listening", resolve));
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("missing port");
            const filters = {
                from: "2026-10-01T00:00:00+08:00",
                to: "2026-10-02T00:00:00+08:00",
                compare: "none",
                departmentBasis: "at_event",
                userIds: [person],
                departmentIds: [department],
                boardKeys: ["image"],
                modelConfigIds: [model],
                operationTypes: ["image_generation"],
                search: "Alice",
            };
            const send = (page: string, selected = filters) =>
                fetch(`http://127.0.0.1:${address.port}/api/admin/usage/report-v2`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ page, period: "selected", filters: selected }),
                });
            const missing = await send("overview");
            expect(missing.status).toBe(409);
            expect((await missing.json()).code).toBe("USAGE_ROLLUP_REFRESH_REQUIRED");
            expect((await db.query("SELECT count(*)::int AS n FROM usage_rollup_jobs")).rows[0].n).toBe(0);
            await queueUsageRollup(
                db,
                { fromDay: "2026-10-01", toDay: "2026-10-01", idempotencyKey: randomUUID() },
                actor,
            );
            expect((await processUsageRollups(db, 1))[0]!.status).toBe("processed");
            const factsBefore = (await db.query("SELECT payload FROM usage_daily_facts ORDER BY payload->>'id'")).rows;
            for (const page of ["overview", "people", "boards", "models", "quality", "flows"] as const) {
                const response = await send(page);
                expect(response.status).toBe(200);
                expect(response.headers.get("cache-control")).toBe("no-store");
                const body = (await response.json()) as { code: number; data: UsageV2ReportResult };
                expect(body.code).toBe(0);
                const report = body.data,
                    content = JSON.parse(report.content);
                expect(report.page).toBe(page);
                expect(report.scope).toMatchObject({
                    from: "2026-09-30T16:00:00.000Z",
                    to: "2026-10-01T16:00:00.000Z",
                    departmentBasis: "at_event",
                    filters: {
                        selectedPeopleCount: 1,
                        selectedDepartmentCount: 1,
                        selectedModelCount: 1,
                        searchApplied: true,
                    },
                });
                expect(report.dataMode).toBe("persisted_daily_facts");
                expect(report.estimatedCharacters).toBe(report.content.length);
                for (const privateValue of [
                    "PRIVATE_",
                    "private.invalid",
                    person,
                    outsider,
                    actor,
                    department,
                    model,
                    "Alice",
                ])
                    expect(JSON.stringify(report)).not.toContain(privateValue);
                if (["overview", "people", "quality"].includes(page)) {
                    expect(content.metrics.generationRequests.value).toBe(1);
                    expect(content.metrics.generatedImages.value).toBe(1);
                    expect(content.metrics.generationBookedCny.amount).toBe("0.234567");
                }
            }
            const currentDepartmentResult = await (
                await send("overview", { ...filters, departmentIds: [currentDepartment] })
            ).json();
            expect(JSON.parse(currentDepartmentResult.data.content).metrics.generationRequests.value).toBe(0);
            const audits = (await db.query("SELECT detail FROM audit_logs WHERE action='usage.v2.report.generated'"))
                .rows;
            expect(audits).toHaveLength(7);
            expect(audits[0]!.detail).toMatchObject({
                selectedPeople: 1,
                boardCount: 1,
                departmentCount: 1,
                modelCount: 1,
                operationCount: 1,
                searchApplied: true,
            });
            expect(JSON.stringify(audits)).not.toContain("Alice");
            expect(JSON.stringify(audits)).not.toContain(person);
            expect((await db.query("SELECT payload FROM usage_daily_facts ORDER BY payload->>'id'")).rows).toEqual(
                factsBefore,
            );
            expect((await db.query("SELECT count(*)::int AS n FROM usage_analysis_previews")).rows[0].n).toBe(0);
            expect((await db.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(0);
            expect(modelCalls).toBe(0);
        } finally {
            if (server) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server!.close(() => resolve()));
            }
            await fixture.close();
        }
    },
    120000,
);
