import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Database } from "../../src/db";
import type { AppConfig } from "../../src/config";
import type { UsageV2Scope } from "../../../shared/usage-analytics-v2";
import { readUsageMatureResults } from "../../src/usage-mature-results";
import { createAdminUsageRouter } from "../../src/routes/usage-analytics";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlSuite = process.env.PGLITE_RUNTIME_PATH ? describe : describe.skip;
sqlSuite("independent mature result window, existing facts only", () => {
    let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, db: Database, server: ReturnType<ReturnType<typeof express>["listen"]>, base: string;
    const user = randomUUID(), other = randomUUID(), guest = randomUUID(), admin = randomUUID(), dept = randomUUID(), currentDept = randomUUID(), provider = randomUUID(), model = randomUUID(), otherModel = randomUUID();
    const compilation = randomUUID(), recipeVersion = randomUUID();
    const asOf = "2026-10-20T00:00:00.000Z", done = "2026-10-13T00:00:00.000Z";
    const scope: UsageV2Scope = { from: "2026-10-12T00:00:00Z", to: "2026-10-13T00:00:00Z", timezone: "Asia/Shanghai", compare: "previous_period", departmentBasis: "at_event", departmentIds: [dept], userIds: [user], boardKeys: ["image"], modelConfigIds: [model], operationTypes: ["image_generation"], search: "Team%_" };
    const task = async (options: { at?: string; completed?: string | null; started?: string | null; userId?: string; departmentId?: string; board?: string; modelId?: string; operation?: string; status?: string; cost?: string | null; compilationId?: string; optimized?: boolean } = {}) => {
        const id = randomUUID();
        await fixture.db.query(`INSERT INTO tasks(id,request_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,tool_key,status,queued_at,started_at,completed_at,prompt_compilation_id,prompt_optimized,rmb_cost)
            VALUES($1,$1::uuid::text,$2,$3,'private-project',$4,$5,'PRIVATE_TASK_PROMPT','{"private":"PRIVATE_PARAMETERS"}',$6,$7,$8,$9,$10,$11,$12,999)`,
        [id, options.userId ?? user, options.departmentId ?? dept, options.operation ?? "image_generation", options.modelId ?? model, options.board ?? "image", options.status ?? "success", options.at ?? scope.from, options.started ?? null, options.completed === undefined ? done : options.completed, options.compilationId ?? null, options.optimized ?? false]);
        if (options.cost !== null) await fixture.db.query(`INSERT INTO generation_history(task_id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,credits,rmb_cost,status)
            SELECT id,user_id,department_id,project_id,operation_type,model_config_id,prompt,parameters,source_urls,result_urls,0,$2,'success' FROM tasks WHERE id=$1`, [id, options.cost ?? "1"]);
        return id;
    };
    const asset = async (taskId: string, options: { owner?: string; index?: number; role?: string; kind?: string; deleted?: boolean } = {}) => {
        const id = randomUUID();
        await fixture.db.query(`INSERT INTO assets(id,owner_user_id,department_id,task_id,object_key,filename,mime_type,kind,status,metadata,deleted_at)
            VALUES($1,$2,$3,$4,$1::uuid::text,'PRIVATE_FILENAME',$5,$6,'ready',$7,$8)`,
        [id, options.owner ?? user, dept, taskId, options.kind === "video" ? "video/mp4" : "image/png", options.kind ?? "image", JSON.stringify({ private: "PRIVATE_ASSET", imageResult: { version: 1, resultIndex: options.index ?? 0, role: options.role ?? "primary", original: { assetId: id, filename: "PRIVATE_FILENAME", mimeType: "image/png" }, maskComposited: false } }), options.deleted ? "2026-10-19T01:00:00Z" : null]);
        return id;
    };
    const outputs = async (taskId: string, assetIds: string[], extras: unknown[] = []) => {
        const urls = JSON.stringify([...assetIds.map(id => `/api/assets/${id}/content`), ...extras]);
        await fixture.db.query("UPDATE tasks SET result_urls=$2 WHERE id=$1", [taskId, urls]);
        await fixture.db.query("UPDATE generation_history SET result_urls=$2 WHERE task_id=$1", [taskId, urls]);
    };
    const event = async (assetId: string, taskId: string, type: string, at: string, options: { userId?: string; source?: string; first?: boolean } = {}) => {
        const id = randomUUID();
        await fixture.db.query(`INSERT INTO asset_events(id,asset_id,designer_user_id,task_id,event_type,prompt,metadata,idempotency_key,occurred_at,source_event_id,first_effective)
            VALUES($1,$2,$3,$4,$5,'PRIVATE_EVENT_PROMPT','{"private":"PRIVATE_EVENT"}',$1::uuid::text,$6,$7,$8)`, [id, assetId, options.userId ?? user, taskId, type, at, options.source ?? null, options.first ?? false]);
        return id;
    };
    beforeAll(async () => {
        fixture = await createIsolatedPostgres();
        // Fixed PostgreSQL transaction clock makes microsecond cutoff and equality assertions deterministic.
        db = { ...fixture.db, connect: async () => { const client = await fixture.db.connect(); return { query: (sql: string, args?: unknown[]) => client.query(sql.replaceAll("transaction_timestamp()", `'${asOf}'::timestamptz`), args), release: () => client.release() }; } } as unknown as Database;
        await fixture.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Old','mature-old'),($2,'Current','mature-current')", [dept, currentDept]);
        for (const [id, name, isGuest, role] of [[user, "Team%_literal", false, "designer"], [other, "TeamXXwildcard", false, "designer"], [guest, "Guest", true, "designer"], [admin, "Admin", false, "super_admin"]])
            await fixture.db.query("INSERT INTO users(id,username,display_name,role,is_guest,department_id,must_change_password) VALUES($1,$2::text,$2::text,$3,$4,$5,false)", [id, name, role, isGuest, currentDept]);
        await fixture.db.query("INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES($1,'Synthetic','openai','https://never-called.invalid','unused')", [provider]);
        for (const id of [model, otherModel]) await fixture.db.query("INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,rmb_cost) VALUES($1,$2,'Synthetic',$1::uuid::text,ARRAY['generate'],9999)", [id, provider]);
        await fixture.db.query("INSERT INTO prompt_recipes(key,settings,updated_at) VALUES('free-optimize','{}','2026-10-01T00:00:00Z')");
        await fixture.db.query("INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES($1,'free-optimize',1,'hash','{\"systemPrompt\":\"PRIVATE_RECIPE\"}','test','2026-10-01T00:00:00Z')", [recipeVersion]);
        await fixture.db.query("INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,details,created_at) VALUES($1,$2,$1,'hash','free-optimize',$3,'success','{\"prompt\":\"PRIVATE_COMPILATION\"}','2026-10-01T00:00:00Z')", [compilation, user, recipeVersion]);
        const a = await task({ cost: "0", compilationId: compilation }), primary = await asset(a, { deleted: true }), original = await asset(a, { role: "provider-original" }), exported = await asset(a, { role: "export" });
        await outputs(a, [primary, original, exported, primary]);
        const lateRevoked = await event(original, a, "asset.downloaded", "2026-10-19T23:59:59.999999Z");
        await event(original, a, "asset.event_reversed", "2026-10-21T00:00:00Z", { source: lateRevoked });
        const earlyRevoked = await event(exported, a, "asset.adopted", "2026-10-14T00:00:00Z");
        await event(exported, a, "asset.event_reversed", "2026-10-19T23:59:59.999999Z", { source: earlyRevoked });
        await event(primary, a, "asset.delivered", asOf); // cutoff is exclusive
        await event(primary, a, "asset.reused", "2026-10-12T23:59:59.999999Z");
        await event(primary, a, "asset.adopted", done, { userId: other }); // wrong designer
        const b = await task({ cost: "2", optimized: true }), bAsset = await asset(b), foreign = await asset(b, { owner: other }), video = await asset(b, { kind: "video", index: 1 });
        await outputs(b, [bAsset, foreign, video], ["https://PRIVATE.invalid/result.png", "https://PRIVATE.invalid/result.png", "", null, { private: "PRIVATE_PAYLOAD" }]);
        await event(bAsset, b, "asset.adopted", done); // lower boundary inclusive
        await event(foreign, b, "asset.downloaded", done); // wrong owner cannot bind
        await event(bAsset, a, "asset.reused", done); // wrong task cannot bind
        await task({ cost: null }); // no final outputs, no settlement: do not fill zero
        await task({ completed: "2026-10-13T00:00:00.000001Z" });
        await task({ completed: null });
        await task({ completed: "2026-10-11T23:59:59Z" });
        await task({ completed: "2026-10-21T00:00:00Z" });
        await task({ started: "2026-10-14T00:00:00Z" });
        const prior = await task({ at: "2026-10-11T00:00:00Z", completed: "2026-10-12T00:00:00Z", cost: "4" }), priorAsset = await asset(prior);
        await outputs(prior, [priorAsset]); await event(priorAsset, prior, "asset.downloaded", "2026-10-18T00:00:00Z");
        for (const options of [{ userId: other }, { userId: guest }, { modelId: otherModel }, { board: "canvas-image" }, { operation: "upscale" }, { departmentId: currentDept }, { status: "failed" }, { status: "waiting" }, { at: "2026-10-13T00:00:00Z" }]) await task(options);
        const app = express();
        app.use((request, _response, next) => { if (request.header("x-role") !== "anonymous") Object.assign(request, { auth: { id: admin, role: request.header("x-role") || "super_admin" } }); next(); });
        app.use("/api/admin/usage", createAdminUsageRouter(db, {} as AppConfig, { complete: async () => { throw new Error("provider must never run"); } }));
        app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(500).json({ code: "TEST_ERROR" }));
        server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/usage/mature-results`;
    }, 120000);
    afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await fixture?.close(); });

    test("matures at exact 168-hour cutoff; separates incomplete and anomalous clocks", async () => {
        const result = await readUsageMatureResults(db, scope);
        expect(result.meta.asOf).toBe(asOf); expect(result.meta.scope).toEqual(scope); expect(result.meta.observationHours).toBe(168);
        expect(result.current.cohort).toEqual({ successfulImageTasks: 8, matureTasks: 3, immatureTasks: 1, missingCompletedAtTasks: 1, invalidTimelineTasks: 3 });
        expect(result.comparison?.cohort.matureTasks).toBe(1);
        expect(result.current.all).toMatchObject({ tasks: 3, outputKnownTasks: 2, missingOutputTasks: 1, generatedResults: 4, linkedResults: 2, unknownBindingResults: 2 });
    });
    test("uses microsecond half-open events, pre-cutoff reversals and same-owner/task identity; ignores first_effective", async () => {
        const all = (await readUsageMatureResults(db, scope)).current.all;
        expect(all).toMatchObject({ usedResults: 2, formallyAdoptedResults: 1, linkedNoEvidenceResults: 0, clientReportedUsedResults: 1, serverConfirmedUsedResults: 1, beforeCompletionEvents: 1, windowEvents: 3, reversedWindowEvents: 1 });
        expect(all.useRate).toEqual({ value: 0.5, state: "partial" }); expect(all.adoptionRate).toEqual({ value: 0.25, state: "partial" });
        // Soft-deleted primary + original/export are one final result; day-eight reversal cannot erase day-seven receipt.
        expect(all.generatedResults).toBe(4);
    });
    test("keeps mature cohort booked-only costs and explicit optimization association, never a causal label", async () => {
        const result = await readUsageMatureResults(db, scope), all = result.current.all;
        expect(all.cost).toEqual({ bookedAmount: "2.000000", settledTasks: 2, missingSettlementTasks: 1, state: "partial", perRecordedUsedResult: "1.000000", perUsedState: "partial" });
        expect(result.current.optimizationGroups.map(row => [row.key, row.summary.tasks])).toEqual([["explicit_link", 1], ["no_explicit_marker", 2]]);
        expect(result.current.optimizationGroups[0]!.summary.cost).toMatchObject({ bookedAmount: "0.000000", perRecordedUsedResult: "0.000000", state: "available" });
        expect(result.comparison?.all.cost).toMatchObject({ bookedAmount: "4.000000", perRecordedUsedResult: "4.000000", state: "available" });
        expect(result.meta.notes.join(" ")).toContain("无标记不等于未优化");
    });
    test("retains every original filter in both periods and current/event department choice", async () => {
        expect((await readUsageMatureResults(db, { ...scope, departmentBasis: "current" })).current.cohort.successfulImageTasks).toBe(0);
        expect((await readUsageMatureResults(db, { ...scope, departmentBasis: "current", departmentIds: [currentDept] })).current.cohort.successfulImageTasks).toBe(9);
        const literal = await readUsageMatureResults(db, { ...scope, userIds: undefined }); expect(literal.current.cohort.successfulImageTasks).toBe(8); expect(literal.comparison?.cohort.successfulImageTasks).toBe(1);
        for (const addition of [{ userIds: [admin] }, { boardKeys: ["never"] }, { modelConfigIds: [randomUUID()] }, { operationTypes: ["remove_background"] }, { search: "not-existing" }]) {
            const result = await readUsageMatureResults(db, { ...scope, ...addition }); expect(result.current.cohort.successfulImageTasks).toBe(0); expect(result.comparison?.cohort.successfulImageTasks).toBe(0);
        }
    });
    test("empty and wholly unbound denominators remain unavailable rather than fake zero", async () => {
        const empty = await readUsageMatureResults(db, { ...scope, search: "not-existing", compare: "none" });
        expect(empty.comparison).toBeNull(); expect(empty.current.all.useRate).toEqual({ value: null, state: "unavailable" }); expect(empty.current.all.cost.bookedAmount).toBeNull();
        const id = await task({ at: "2026-10-09T00:00:00Z", completed: "2026-10-10T00:00:00Z", cost: "0" }); await outputs(id, [], ["https://PRIVATE.invalid/unknown.png"]);
        const unknown = await readUsageMatureResults(db, { ...scope, from: "2026-10-09T00:00:00Z", to: "2026-10-10T00:00:00Z", compare: "none" });
        expect(unknown.current.all).toMatchObject({ generatedResults: 1, unknownBindingResults: 1, linkedNoEvidenceResults: 0, usedResults: 0, useRate: { value: null, state: "unavailable" } });
        expect(unknown.current.all.cost).toMatchObject({ bookedAmount: "0.000000", perRecordedUsedResult: null, perUsedState: "unavailable" });
    });
    test("one read-only snapshot, private projection, no rollup or current soft-deletion filtering", async () => {
        const start = fixture.statements.length, result = await readUsageMatureResults(db, scope), statements = fixture.statements.slice(start), sql = statements.join("\n");
        expect(statements.filter(value => value.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"))).toHaveLength(1); expect(statements.filter(value => value === "COMMIT")).toHaveLength(1);
        expect(statements.some(value => /^\s*(INSERT|UPDATE|DELETE)/i.test(value))).toBe(false);
        expect(sql).not.toMatch(/deleted_at|first_effective|usage_daily|SELECT \*|rawResponse|inputSnapshot|systemPrompt|encrypted_credentials|e\.prompt|e\.metadata|t\.prompt[, ]/);
        const json = JSON.stringify(result); expect(json).not.toContain("PRIVATE_"); expect(JSON.stringify([result.current, result.comparison])).not.toContain(user); expect(json).not.toContain(compilation); expect(json).not.toContain("/api/assets/");
    });
    test("cutoff-time reversal does not remove evidence, while bound no-receipt zero is not unknown", async () => {
        const at = "2026-10-07T00:00:00Z", completed = "2026-10-08T00:00:00Z", cutoff = "2026-10-15T00:00:00Z";
        const first = await task({ at, completed, cost: "0" }), firstAsset = await asset(first), second = await task({ at, completed, cost: "0" }), secondAsset = await asset(second);
        await fixture.db.query("UPDATE assets SET metadata='{}' WHERE id=$1", [firstAsset]);
        await outputs(first, [firstAsset, firstAsset.toUpperCase()]); await outputs(second, [secondAsset]);
        const receipt = await event(firstAsset, first, "asset.exported", completed);
        await event(firstAsset, first, "asset.event_reversed", cutoff, { source: receipt });
        await event(firstAsset, first, "asset.event_reversed", "2026-10-14T00:00:00Z", { source: receipt, userId: other });
        const result = await readUsageMatureResults(db, { ...scope, from: at, to: completed, compare: "none" });
        expect(result.current.all).toMatchObject({ tasks: 2, generatedResults: 2, linkedResults: 2, usedResults: 1, linkedNoEvidenceResults: 1, reversedWindowEvents: 0, useRate: { value: 0.5, state: "available" }, adoptionRate: { value: 0, state: "available" } });
        expect(result.current.all.cost).toMatchObject({ bookedAmount: "0.000000", perRecordedUsedResult: "0.000000", perUsedState: "available" });
    });
    test("actual PostgreSQL transaction time and previous-year cohort remain coherent", async () => {
        const before = Date.now(), result = await readUsageMatureResults(fixture.db, { ...scope, compare: "previous_year" }), after = Date.now();
        expect(Date.parse(result.meta.asOf)).toBeGreaterThanOrEqual(before - 1000); expect(Date.parse(result.meta.asOf)).toBeLessThanOrEqual(after + 1000);
        expect(result.meta.comparisonScope?.from).toBe("2025-10-12T00:00:00.000Z"); expect(result.comparison?.cohort.successfulImageTasks).toBe(0);
        expect(result.current.cohort.successfulImageTasks).toBe(8);
    });
    test("HTTP requires superadmin, explicit valid scope and no-store; only minimal audit is written", async () => {
        const query = new URLSearchParams(Object.entries(scope).filter(([key]) => key !== "timezone").map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]));
        for (const role of ["anonymous", "designer", "department_admin"]) { const response = await fetch(`${base}?${query}`, { headers: { "x-role": role } }); expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); }
        expect((await fetch(base)).status).toBe(400);
        const response = await fetch(`${base}?${query}`); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json() as { code: number; data: { current: { all: { usedResults: number } } } }; expect(body.code).toBe(0); expect(body.data.current.all.usedResults).toBe(2); expect(JSON.stringify(body)).not.toContain("PRIVATE_");
        const audit = (await fixture.db.query("SELECT detail FROM audit_logs WHERE action='usage.v2.mature_results.viewed'")).rows; expect(audit).toHaveLength(1); expect(Object.keys(audit[0].detail).sort()).toEqual(["from", "matureTasks", "resultCount", "to"]);
    });
    test("rejects excessive relation/byte budget before returning a partial result", async () => {
        for (const budget of [{ count: 1, bytes: "1", results: "100001" }, { count: 50001, bytes: "1", results: "1" }, { count: 1, bytes: String(32 * 1024 * 1024 + 1), results: "1" }]) {
            const statements: string[] = []; let released = false;
            const fake = { connect: async () => ({ query: async (sql: string) => { statements.push(sql); return { rows: sql.includes("AS snapshot_at") ? [{ snapshot_at: asOf }] : sql.includes("AS bytes") ? [budget] : [] }; }, release() { released = true; } }) } as unknown as Database;
            await expect(readUsageMatureResults(fake, scope)).rejects.toMatchObject({ code: "USAGE_MATURE_SCOPE_TOO_LARGE", status: 422 });
            expect(statements.at(-1)).toBe("ROLLBACK"); expect(released).toBe(true);
        }
    });
});
