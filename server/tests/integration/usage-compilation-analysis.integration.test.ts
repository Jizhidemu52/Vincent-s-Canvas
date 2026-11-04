import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AppConfig } from "../../src/config";
import type { Database } from "../../src/db";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { readUsageCompilationAnalysis } from "../../src/usage-compilation-analysis";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
sqlSuite("independent prompt compilation analysis on existing scalar metadata", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
    const user = randomUUID(), otherUser = randomUUID(), department = randomUUID(), otherDepartment = randomUUID();
    const admin = randomUUID(), provider = randomUUID(), model = randomUUID(), recipe = "free-optimize", version = randomUUID();
    const ids = Object.fromEntries(["a", "cacheA", "b", "c", "d", "f", "malformed", "prior", "cachePrior", "outside", "recent"].map(key => [key, randomUUID()]));
    const scope: UsageV2Scope = { from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z", timezone: "Asia/Shanghai", compare: "previous_period", departmentBasis: "current", departmentIds: [department], userIds: [user], search: "Team%_" };
    const privateFields = { rawResponse: "PRIVATE_PROVIDER_RESPONSE", prompt: "PRIVATE_PROMPT", inputSnapshot: { promptInput: { userText: "PRIVATE_EMPLOYEE_INPUT" } }, systemPrompt: "PRIVATE_RULES" };
    const addCompilation = async (id: string, status: string, details: Record<string, unknown>, options: { at?: string; reuse?: string; userId?: string } = {}) => {
        await fixture.db.query("INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,reused_from_id,details,created_at) VALUES($1,$2,$1,'synthetic',$3,$4,$5,$6,$7,$8)", [id, options.userId ?? user, recipe, version, status, options.reuse ?? null, JSON.stringify({ ...privateFields, ...details }), options.at ?? "2026-10-02T01:00:00Z"]);
    };
    const addTask = async (compilationId: string, userId = user, at = "2026-10-04T01:00:00Z") => {
        const id = randomUUID();
        await fixture.db.query("INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,queued_at,prompt_compilation_id) VALUES($1,$1::uuid::text,$2,$3,'fixture','image_generation',$4,'PRIVATE_TASK_PROMPT','{\"private\":\"PRIVATE_PARAMETERS\"}','image','waiting',$5,$6)", [id, userId, department, model, at, compilationId]);
    };
    const send = (query: Record<string, string> = {}, role = "super_admin") => fetch(`${base}?${new URLSearchParams({ from: scope.from, to: scope.to, compare: scope.compare, departmentBasis: "current", departmentIds: department, userIds: user, search: "Team%_", ...query })}`, { headers: { "x-role": role } });
    beforeAll(async () => {
        fixture = await createIsolatedPostgres();
        await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Team','compilation-team'),($2,'Other','compilation-other')", [department, otherDepartment]);
        for (const [id, name, role, dept] of [[user, "Team%_literal", "designer", department], [otherUser, "TeamXXwildcard", "designer", otherDepartment], [admin, "Admin", "super_admin", otherDepartment]])
            await fixture.db.query("INSERT INTO users(id,username,display_name,role,department_id,must_change_password) VALUES($1,$2::text,$2::text,$3,$4,false)", [id, name, role, dept]);
        await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Synthetic','openai','https://never-called.invalid','unused')", [provider]);
        await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'Synthetic','analysis-test',ARRAY['generate'],9999)", [model, provider]);
        await fixture.db.query("INSERT INTO prompt_recipes(key,settings,updated_at) VALUES($1,'{}','2026-09-01T00:00:00Z')", [recipe]);
        await fixture.db.query("INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES($1,$2,1,'hash','{\"systemPrompt\":\"PRIVATE_RECIPE_RULES\"}','synthetic','2026-09-01T00:00:00Z')", [version, recipe]);
        await addCompilation(ids.a!, "success", { adminTest: false, inputTokens: 10, outputTokens: 20, latencyMs: 100, actualCost: 0.1, currency: "CNY" });
        await addCompilation(ids.cacheA!, "optimizing", { adminTest: false, inputTokens: 9999, outputTokens: 9999, latencyMs: 9999, actualCost: 9999, currency: "CNY" }, { reuse: ids.a });
        await addCompilation(ids.b!, "failed", { adminTest: true, inputTokens: null, outputTokens: 5, latencyMs: 300, estimatedCost: 0.2, currency: "CNY" });
        await addCompilation(ids.c!, "uncertain", { inputTokens: 7, outputTokens: null, latencyMs: -1, actualCost: 0.003, currency: "USD" });
        await addCompilation(ids.d!, "optimizing", { adminTest: false, currency: "CNY" });
        await addCompilation(ids.f!, "success", { adminTest: false, inputTokens: 0, outputTokens: 0, latencyMs: 0, actualCost: 0, currency: "CNY" });
        await addCompilation(ids.malformed!, "failed", { adminTest: "true", inputTokens: -1, outputTokens: 0.5, latencyMs: "5", actualCost: "1", currency: "usd" });
        await addCompilation(ids.prior!, "success", { adminTest: false, inputTokens: 500, outputTokens: 500, latencyMs: 5000, actualCost: 50, currency: "USD" }, { at: "2026-10-01T01:00:00Z" });
        await addCompilation(ids.cachePrior!, "success", { adminTest: false }, { reuse: ids.prior });
        await addCompilation(ids.outside!, "success", { adminTest: true, inputTokens: 999, outputTokens: 999, latencyMs: 999, actualCost: 999, currency: "CNY" }, { userId: otherUser });
        await addCompilation(ids.recent!, "optimizing", { adminTest: false }, { at: new Date(Date.now() - 10_000).toISOString() });
        await addTask(ids.a!); await addTask(ids.a!); await addTask(ids.cacheA!);
        // A corrupt cross-user task association is not proof of this user's task submission.
        await addTask(ids.b!, otherUser);
        const app = express();
        app.use((request, _response, next) => { if (request.header("x-role") !== "anonymous") Object.assign(request, { auth: { id: admin, role: request.header("x-role") || "super_admin" } }); next(); });
        app.use("/api/admin/usage", createAdminUsageRouter(fixture.db, {} as AppConfig, { complete: async () => { throw new Error("provider must not be called"); } }));
        app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(500).json({ code: "TEST_ERROR" }));
        server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/usage/compilations`;
    }, 120000);
    afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await fixture?.close(); });

    test("includes unlinked requests, same-snapshot comparisons, and admin-test coverage without reading private fields", async () => {
        const start = fixture.statements.length;
        const result = await readUsageCompilationAnalysis(fixture.db, scope), all = result.current.all;
        expect(result.meta.scope).toEqual(scope); expect(result.meta.dataMode).toBe("live_existing_compilations");
        expect(all).toMatchObject({ requests: 8, linkedRequests: 2, unlinkedRequests: 6, linkedTasks: 3, sourceCalls: 6, cacheHits: 2, cacheSourceOutsideScope: 1, cacheSourceMissing: 0, adminTests: { yes: 1, no: 5, unknown: 2 } });
        expect(all.statuses).toEqual({ success: 4, failed: 2, uncertain: 2, optimizing: 0 });
        expect(all.sourceStatuses).toEqual({ success: 2, failed: 2, uncertain: 2, optimizing: 0 });
        expect(result.current.linked).toMatchObject({ requests: 2, sourceCalls: 1, cacheHits: 1, linkedTasks: 3 });
        expect(result.current.unlinked.requests).toBe(6);
        expect(result.comparison?.all).toMatchObject({ requests: 1, sourceCalls: 1, inputTokens: { value: 500 } });
        expect(result.comparison?.all.costs[0]).toMatchObject({ currency: "USD", actualAmount: "50.000000" });
        const statements = fixture.statements.slice(start);
        expect(statements.filter(sql => sql.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"))).toHaveLength(1);
        expect(statements.filter(sql => sql.includes("SELECT transaction_timestamp()"))).toHaveLength(1);
        expect(statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
        expect(statements.join("\n")).not.toMatch(/rawResponse|inputSnapshot|systemPrompt|recipe_versions|model_configs|user_input|SELECT \*/);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_");
        expect(JSON.stringify(result)).not.toContain(ids.a!);
        expect((await fixture.db.query("SELECT status FROM prompt_compilations WHERE id=$1", [ids.d])).rows[0].status).toBe("optimizing");
    });
    test("counts only original source tokens and costs; missing and explicit zero remain distinct", async () => {
        const all = (await readUsageCompilationAnalysis(fixture.db, scope)).current.all;
        expect(all.inputTokens).toEqual({ value: 17, state: "partial", availableCount: 3, missingCount: 3 });
        expect(all.outputTokens).toEqual({ value: 25, state: "partial", availableCount: 3, missingCount: 3 });
        expect(all.completeTokenCalls).toBe(2);
        expect(all.latency).toMatchObject({ sourceCalls: 6, availableCount: 3, missingCount: 3, p50Ms: 100, p90Ms: 260 });
        expect(all.latency.meanMs).toBeCloseTo(400 / 3);
        expect(all.costs).toEqual([
            { currency: "CNY", sourceCalls: 4, actualAmount: "0.100000", estimatedAmount: "0.200000", actualCount: 2, estimatedCount: 1, unknownCount: 1 },
            { currency: "unknown", sourceCalls: 1, actualAmount: null, estimatedAmount: null, actualCount: 0, estimatedCount: 0, unknownCount: 1 },
            { currency: "USD", sourceCalls: 1, actualAmount: "0.003000", estimatedAmount: null, actualCount: 1, estimatedCount: 0, unknownCount: 0 },
        ]);
        const empty = await readUsageCompilationAnalysis(fixture.db, { ...scope, search: "not-existing" });
        expect(empty.current.all.requests).toBe(0);
        expect(empty.current.all.inputTokens).toEqual({ value: null, state: "unavailable", availableCount: 0, missingCount: 0 });
        expect(empty.current.all.costs).toEqual([]);
        expect(empty.current.all.latency.p50Ms).toBeNull();
    });
    test("never guesses missing dimensions or widens user/name/current-department filters", async () => {
        for (const addition of [{ departmentBasis: "at_event" as const }, { boardKeys: ["image"] }, { modelConfigIds: [model] }, { operationTypes: ["image_generation"] }]) {
            const count = fixture.statements.length;
            await expect(readUsageCompilationAnalysis(fixture.db, { ...scope, ...addition })).rejects.toMatchObject({ code: "USAGE_COMPILATION_FILTER_UNSUPPORTED", status: 400 });
            expect(fixture.statements.length).toBe(count);
        }
        const literalSearch = await readUsageCompilationAnalysis(fixture.db, { ...scope, departmentIds: undefined, userIds: undefined });
        expect(literalSearch.current.all.requests).toBe(8);
        const mismatch = await readUsageCompilationAnalysis(fixture.db, { ...scope, departmentIds: [otherDepartment] });
        expect(mismatch.current.all.requests).toBe(0);
        const recent = await readUsageCompilationAnalysis(fixture.db, { ...scope, from: new Date(Date.now() - 100_000).toISOString(), to: new Date(Date.now() + 1000).toISOString(), compare: "none" });
        expect(recent.current.all.statuses.optimizing).toBe(1); expect(recent.comparison).toBeNull();
    });
    test("cache-only windows report source-outside counts and no inherited money or tokens", async () => {
        const id = randomUUID();
        await addCompilation(id, "success", { adminTest: false, actualCost: 5000, currency: "USD", inputTokens: 5000, outputTokens: 5000 }, { at: "2026-10-05T01:00:00Z", reuse: ids.prior });
        const result = await readUsageCompilationAnalysis(fixture.db, { ...scope, from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z", compare: "none" });
        expect(result.current.all).toMatchObject({ requests: 1, sourceCalls: 0, cacheHits: 1, cacheSourceOutsideScope: 1, inputTokens: { value: null, state: "unavailable" }, costs: [] });
        const anomalous = randomUUID();
        await addCompilation(anomalous, "success", { adminTest: false }, { at: "2026-10-05T02:00:00Z", reuse: ids.outside });
        const after = await readUsageCompilationAnalysis(fixture.db, { ...scope, from: result.current.from, to: result.current.to, compare: "none" });
        expect(after.current.all.cacheSourceMissing).toBe(1); expect(after.current.all.statuses.uncertain).toBe(1);
    });
    test("stored zero actual takes precedence over estimates and costs use six-place decimal rounding", async () => {
        const at = "2026-10-06T01:00:00Z";
        await addCompilation(randomUUID(), "success", { adminTest: true, actualCost: 0.0000005, currency: "CNY" }, { at });
        await addCompilation(randomUUID(), "success", { adminTest: false, actualCost: 0, estimatedCost: 99, currency: "CNY" }, { at });
        await addCompilation(randomUUID(), "success", { actualCost: 50 }, { at });
        const result = await readUsageCompilationAnalysis(fixture.db, { ...scope, from: "2026-10-06T00:00:00Z", to: "2026-10-07T00:00:00Z", compare: "none" });
        expect(result.current.all.costs).toEqual([
            { currency: "CNY", sourceCalls: 2, actualAmount: "0.000001", estimatedAmount: null, actualCount: 2, estimatedCount: 0, unknownCount: 0 },
            { currency: "unknown", sourceCalls: 1, actualAmount: null, estimatedAmount: null, actualCount: 0, estimatedCount: 0, unknownCount: 1 },
        ]);
        expect(result.current.all.inputTokens).toEqual({ value: null, state: "unavailable", availableCount: 0, missingCount: 3 });
    });
    test("HTTP remains super-admin/no-store/strict/audited and never accepts hidden private switches", async () => {
        for (const role of ["designer", "anonymous"]) { const response = await send({}, role); expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); }
        const invalidQueries: Record<string, string>[] = [{ rawPrompt: "PRIVATE_SWITCH" }, { from: "" }, { departmentBasis: "at_event" }, { boardKeys: "image" }, { operationTypes: "image_generation" }];
        for (const invalid of invalidQueries) {
            const response = await send(invalid); expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE_SWITCH");
        }
        const noDates = await fetch(base); expect(noDates.status).toBe(400);
        const response = await send(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json(); expect(body.code).toBe(0); expect(body.data.current.all.requests).toBe(8);
        const audit = await fixture.db.query("SELECT detail FROM audit_logs WHERE action='usage.v2.compilations.viewed'");
        expect(audit.rows).toHaveLength(1); expect(JSON.stringify(audit.rows)).not.toContain("PRIVATE_"); expect(JSON.stringify(audit.rows)).not.toContain("Team%_");
    });
});

test("over-budget compilation reads reject and roll back rather than returning a truncated set", async () => {
    const statements: string[] = [];
    const db = { connect: async () => ({
        query: async (sql: string) => { statements.push(sql); return { rows: sql.includes("SELECT transaction_timestamp()") ? [{ snapshot_at: "2026-11-05T00:00:00Z" }] : sql.includes("SELECT c.id,c.created_at") ? new Array(50_001).fill({}) : [] }; },
        release: () => undefined,
    }) } as unknown as Database;
    await expect(readUsageCompilationAnalysis(db, { from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z", timezone: "Asia/Shanghai", compare: "none", departmentBasis: "at_event" })).rejects.toMatchObject({ code: "USAGE_COMPILATION_SCOPE_TOO_LARGE", status: 422 });
    expect(statements.at(-1)).toBe("ROLLBACK"); expect(statements).not.toContain("COMMIT");
});
