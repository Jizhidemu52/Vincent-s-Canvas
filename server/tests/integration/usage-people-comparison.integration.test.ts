import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../../src/config";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { usagePeopleTeamBaseline, usageV2Metrics, usageV2PeopleComparison } from "../../src/usage-analytics-v2";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { processUsageRollups, queueUsageRollup } from "../../src/usage-rollups";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

test("empty team and incomplete booking never produce a falsely complete average", () => {
    const empty = usagePeopleTeamBaseline(usageV2Metrics([]), 0, "synthetic empty scope");
    expect(empty.perActivePersonBookedCny).toMatchObject({ value: null, state: "unavailable", denominator: 0 });
    expect(empty.perRosterPersonBookedCny).toMatchObject({ value: null, state: "unavailable", denominator: 0 });
    const metrics = usageV2Metrics([]);
    metrics.activePeople.value = 2;
    metrics.generationBookedCny = { ...metrics.generationBookedCny, value: 0.000003, amount: "0.000003", availableCount: 1, missingCount: 1, state: "partial" };
    const partial = usagePeopleTeamBaseline(metrics, 3, "synthetic");
    expect(partial.perActivePersonBookedCny).toMatchObject({ amount: "0.000002", state: "partial", denominator: 2, missingCount: 1 });
    expect(partial.perRosterPersonBookedCny).toMatchObject({ amount: "0.000001", state: "partial", denominator: 3 });
    metrics.generationBookedCny = { ...metrics.generationBookedCny, value: null, state: "unavailable" };
    expect(usagePeopleTeamBaseline(metrics, 3, "synthetic").perRosterPersonBookedCny).toMatchObject({ value: null, state: "unavailable" });
});

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
sqlSuite("one-snapshot selected people and original-scope team", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let base: string;
    const admin = randomUUID(), a = randomUUID(), b = randomUUID(), c = randomUUID(), idle = randomUUID(), outside = randomUUID();
    const department = randomUUID(), otherDepartment = randomUUID(), provider = randomUUID(), model = randomUUID();
    const taskC = randomUUID();
    const scope: UsageV2Scope = { from: "2026-10-01T00:00:00+08:00", to: "2026-10-02T00:00:00+08:00", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "current", userIds: [a, b, c, idle], departmentIds: [department], boardKeys: ["image"], modelConfigIds: [model], operationTypes: ["image_generation"], search: "Team" };
    const filters = () => { const { timezone: _timezone, ...query } = scope; return query; };
    const refresh = async () => {
        await queueUsageRollup(fixture.db, { fromDay: "2026-10-01", toDay: "2026-10-01", idempotencyKey: randomUUID() }, admin);
        expect((await processUsageRollups(fixture.db, 1))[0]?.status).toBe("processed");
    };
    const send = (body: unknown, role = "super_admin") => fetch(`${base}/people-compare`, { method: "POST", headers: { "content-type": "application/json", "x-role": role }, body: JSON.stringify(body) });
    beforeAll(async () => {
        fixture = await createIsolatedPostgres({ usageRollupsEnabled: true });
        await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Team department','comparison-team'),($2,'Outside department','comparison-outside')", [department, otherDepartment]);
        for (const [id, name, role, departmentId] of [[admin, "Admin", "super_admin", otherDepartment], [a, "Team A", "designer", department], [b, "Team B", "designer", department], [c, "Team C", "designer", department], [idle, "Team Idle", "designer", department], [outside, "Outside", "designer", otherDepartment]])
            await fixture.db.query("INSERT INTO users(id,username,display_name,role,department_id,must_change_password) VALUES($1,$2::text,$2::text,$3,$4,false)", [id, name, role, departmentId]);
        await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Synthetic','openai','https://never-called.invalid','no-provider-call')", [provider]);
        await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'Synthetic model','comparison-model',ARRAY['generate'],0)", [model, provider]);
        const add = async (userId: string, status: string, latency: number, cost: string | null, board = "image", taskId = randomUUID()) => {
            await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,result_urls,queued_at,started_at,completed_at) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'PRIVATE_PROMPT','{}',$5,$6,'[\"https://private.invalid/PRIVATE_IMAGE.png\"]','2026-10-01T01:00:00Z','2026-10-01T01:00:00Z','2026-10-01T01:00:00Z'::timestamptz+($7::int*interval '1 millisecond'))", [taskId, userId, userId === outside ? otherDepartment : department, model, board, status, latency]);
            if (cost !== null) await fixture.db.query("INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status) SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1", [taskId, cost]);
        };
        await add(a, "success", 10, "1.000001");
        for (const latency of [20, 30, 40]) await add(b, "success", latency, "1");
        for (let index = 0; index < 5; index++) await add(b, "failed", 5, null);
        await add(c, "success", 100, "4", "image", taskC);
        await add(c, "success", 200, "99", "canvas-image");
        await add(outside, "success", 300, "100");
        await refresh();
        const app = express(); app.use(express.json());
        app.use((request, _response, next) => { if (request.header("x-role") !== "anonymous") Object.assign(request, { auth: { id: admin, role: request.header("x-role") || "super_admin" } }); next(); });
        app.use("/api/admin/usage", createAdminUsageRouter(fixture.db, {} as AppConfig, { complete: async () => { throw new Error("must never call a provider"); } }));
        app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(500).json({ code: "TEST_ERROR" }));
        server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/usage`;
    }, 120000);
    afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await fixture?.close(); });

    test("uses one original-scope read, pooled denominators, raw latency samples, and distinct populations", async () => {
        const start = fixture.statements.length;
        const result = await usageV2PeopleComparison(fixture.db, scope, [b, a], { source: "daily" });
        const statements = fixture.statements.slice(start);
        expect(statements.filter(sql => sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"))).toHaveLength(1);
        expect(statements.filter(sql => sql.includes("transaction_timestamp()"))).toHaveLength(1);
        expect(statements.filter(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toHaveLength(0);
        expect(result.meta.scope).toEqual(scope);
        expect(result.selectedUserIds).toEqual([b, a]);
        expect(result.people.map(person => person.userId)).toEqual([b, a]);
        expect(result.team.rosterPeople).toBe(4);
        expect(result.team.metrics.activePeople.value).toBe(3);
        expect(result.team.metrics.successRate).toMatchObject({ numerator: 5, denominator: 10, value: 0.5 });
        expect(result.team.metrics.totalMsP50.value).toBe(30);
        expect(result.team.metrics.generationBookedCny.amount).toBe("8.000001");
        expect(result.team.perActivePersonBookedCny).toMatchObject({ amount: "2.666667", denominator: 3, state: "available" });
        expect(result.team.perRosterPersonBookedCny).toMatchObject({ amount: "2.000000", denominator: 4, state: "available" });
        expect(result.team.populationDefinition).toContain("不把这些条件下无记录的名册员工删掉");
        expect(JSON.stringify(result)).not.toContain("PRIVATE_");
        expect(JSON.stringify(result)).not.toContain(outside);
    });
    test("never widens explicit personnel, department, or name filters and rejects an empty team", async () => {
        await expect(usageV2PeopleComparison(fixture.db, scope, [a, outside], { source: "daily" })).rejects.toMatchObject({ code: "USAGE_COMPARISON_OUT_OF_SCOPE" });
        await expect(usageV2PeopleComparison(fixture.db, { ...scope, userIds: undefined }, [a, outside], { source: "daily" })).rejects.toMatchObject({ code: "USAGE_COMPARISON_OUT_OF_SCOPE" });
        await expect(usageV2PeopleComparison(fixture.db, { ...scope, search: "no-matching-employee" }, [a, b], { source: "daily" })).rejects.toMatchObject({ code: "USAGE_COMPARISON_OUT_OF_SCOPE" });
        const event = await usageV2PeopleComparison(fixture.db, { ...scope, departmentBasis: "at_event" }, [a, b], { source: "daily" });
        expect(event.team.rosterPeople).toBe(3);
        expect(event.team.populationDefinition).toContain("不是当时部门编制");
        await expect(usageV2PeopleComparison(fixture.db, { ...scope, departmentBasis: "at_event" }, [a, idle], { source: "daily" })).rejects.toMatchObject({ code: "USAGE_COMPARISON_OUT_OF_SCOPE" });
    });
    test("HTTP is super-admin only, no-store, strict, audited, and returns the original team scope", async () => {
        const body = { filters: filters(), selectedUserIds: [a, b] };
        for (const role of ["designer", "anonymous"]) {
            const denied = await send(body, role); expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("no-store");
        }
        for (const invalid of [{ ...body, selectedUserIds: [a, a] }, { ...body, selectedUserIds: [a] }, { ...body, rawPrompt: "PRIVATE_INPUT" }, { ...body, filters: { ...filters(), from: undefined } }]) {
            const response = await send(invalid); expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE_INPUT");
        }
        const response = await send(body); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
        const result = (await response.json()).data;
        expect(result.meta.scope.userIds).toEqual(scope.userIds);
        expect(result.team.rosterPeople).toBe(4);
        const audited = await fixture.db.query("SELECT action,detail FROM audit_logs WHERE action LIKE '%people.compared%' ORDER BY created_at DESC LIMIT 1");
        expect(audited.rows).toHaveLength(1); expect(JSON.stringify(audited.rows)).not.toContain("PRIVATE_");
    });
    test("missing successful billing stays partial for both population averages after refresh", async () => {
        await fixture.db.query("DELETE FROM generation_history WHERE task_id=$1", [taskC]); await refresh();
        const result = await usageV2PeopleComparison(fixture.db, scope, [a, b], { source: "daily" });
        expect(result.team.metrics.generationBookedCny).toMatchObject({ state: "partial", missingCount: 1, amount: "4.000001" });
        expect(result.team.perActivePersonBookedCny).toMatchObject({ state: "partial", missingCount: 1, denominator: 3 });
        expect(result.team.perRosterPersonBookedCny).toMatchObject({ state: "partial", missingCount: 1, denominator: 4 });
    });
});
