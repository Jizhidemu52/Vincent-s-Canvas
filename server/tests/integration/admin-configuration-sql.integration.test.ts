import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import { createDepartmentsRouter } from "../../src/routes/departments";
import { createInternalAiConfigurationRouter } from "../../src/routes/internal-ai-configuration";
import { createModelConfigurationRouter } from "../../src/routes/model-configuration";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const encryptionKey = Buffer.alloc(32, 19).toString("base64");

async function fixture() {
    const postgres = await createIsolatedPostgres();
    const admin = randomUUID(), department = randomUUID(), otherDepartment = randomUUID();
    await postgres.db.query("INSERT INTO departments(id,name,code) VALUES($1,'Atomic department','atomic-a'),($2,'Other department','atomic-b')", [department, otherDepartment]);
    await postgres.db.query("INSERT INTO users(id,username,display_name,role,department_id) VALUES($1,'configuration-operator','Configuration operator','super_admin',$2)", [admin, department]);
    // Real PostgreSQL trigger failure: a failed audit aborts the transaction even
    // if the application accidentally catches the error before COMMIT.
    await postgres.db.query(`CREATE FUNCTION fail_configuration_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.action = current_setting('canvas_test.fail_audit', true) THEN
                RAISE EXCEPTION 'injected audit failure';
            END IF;
            RETURN NEW;
        END $$`);
    await postgres.db.query("CREATE TRIGGER fail_configuration_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_configuration_test_audit()");
    const config = { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        (request as AuthenticatedRequest).auth = { id: admin, role: request.get("test-role") || "super_admin",
            departmentId: request.get("test-department") === "none" ? null : request.get("test-department") || department } as SessionUser;
        next();
    });
    app.use("/configuration", createModelConfigurationRouter(postgres.db, config));
    app.use("/departments", createDepartmentsRouter(postgres.db));
    app.use("/internal-ai", createInternalAiConfigurationRouter(postgres.db, config));
    app.use(((error, _request, response, _next) => {
        response.status(error.name === "ZodError" ? 400 : error.status || 500).json({ error: error.code || "INTERNAL_ERROR", message: error.message });
    }) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const save = (path: string, input: unknown, method = "POST", headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
        method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
    });
    const failAudit = (action: string) => postgres.db.query("SELECT set_config('canvas_test.fail_audit',$1,false)", [action]);
    const auditCount = async (action: string) => Number((await postgres.db.query("SELECT count(*) FROM audit_logs WHERE action=$1", [action])).rows[0].count);
    const makeProvider = async (name = "Atomic provider") => {
        const response = await save("/configuration/providers", { name, protocol: "openai", baseUrl: "https://provider.example.test/v1", credentials: { apiKey: "test-atomic-key" } });
        expect(response.status).toBe(201);
        return (await response.json()).provider as { id: string };
    };
    const modelInput = (providerId: string, extra: Record<string, unknown> = {}) => ({ providerId, name: "Atomic model", modelId: "atomic-model", capabilities: ["edit", "chat"], creditCost: 7, rmbCost: 0.23, ...extra });
    return { ...postgres, url, save, failAudit, auditCount, makeProvider, modelInput, department, otherDepartment, close: async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await postgres.close();
    } };
}

sqlTest("provider creation and edits roll back business data when the real audit INSERT fails", async () => {
    const state = await fixture();
    try {
        const input = { name: "Rollback provider", protocol: "openai", baseUrl: "https://provider.example.test/v1", credentials: { apiKey: "test-original-key" } };
        await state.failAudit("provider.created");
        expect((await state.save("/configuration/providers", input)).status).toBe(500);
        expect((await state.db.query("SELECT id FROM providers WHERE name=$1", [input.name])).rows).toEqual([]);
        expect(await state.auditCount("provider.created")).toBe(0);
        await state.failAudit("");
        const created = await state.save("/configuration/providers", input);
        expect(created.status).toBe(201);
        const body = await created.json();
        expect(body.provider.hasCredentials).toBe(true);
        expect(JSON.stringify(body)).not.toContain("test-original-key");
        const before = (await state.db.query("SELECT * FROM providers WHERE id=$1", [body.provider.id])).rows[0];
        await state.failAudit("provider.updated");
        expect((await state.save(`/configuration/providers/${body.provider.id}`, { name: "Changed provider", enabled: false, credentials: { apiKey: "test-replacement-key" } }, "PATCH")).status).toBe(500);
        expect((await state.db.query("SELECT * FROM providers WHERE id=$1", [body.provider.id])).rows[0]).toEqual(before);
        expect(await state.auditCount("provider.updated")).toBe(0);
        await state.failAudit("");
        expect((await state.save(`/configuration/providers/${body.provider.id}`, { name: "Renamed provider" }, "PATCH")).status).toBe(200);
        expect((await state.db.query("SELECT encrypted_credentials FROM providers WHERE id=$1", [body.provider.id])).rows[0].encrypted_credentials).toBe(before.encrypted_credentials);
        expect(await state.auditCount("provider.created")).toBe(1);
        expect(await state.auditCount("provider.updated")).toBe(1);
    } finally { await state.close(); }
}, 30_000);

sqlTest("model creation and edits commit together with audit and preserve business state on failure", async () => {
    const state = await fixture();
    try {
        const provider = await state.makeProvider();
        const input = state.modelInput(provider.id);
        await state.failAudit("model.created");
        expect((await state.save("/configuration/models", input)).status).toBe(500);
        expect((await state.db.query("SELECT id FROM model_configs WHERE provider_id=$1", [provider.id])).rows).toEqual([]);
        expect(await state.auditCount("model.created")).toBe(0);
        await state.failAudit("");
        const response = await state.save("/configuration/models", input);
        expect(response.status).toBe(201);
        const { model } = await response.json();
        const before = (await state.db.query("SELECT * FROM model_configs WHERE id=$1", [model.id])).rows[0];
        await state.failAudit("model.updated");
        expect((await state.save(`/configuration/models/${model.id}`, { name: "Changed model", enabled: false, creditCost: 99 }, "PATCH")).status).toBe(500);
        expect((await state.db.query("SELECT * FROM model_configs WHERE id=$1", [model.id])).rows[0]).toEqual(before);
        expect(await state.auditCount("model.updated")).toBe(0);
        await state.failAudit("");
        expect((await state.save(`/configuration/models/${model.id}`, { name: "Saved model" }, "PATCH")).status).toBe(200);
        expect(await state.auditCount("model.created")).toBe(1);
        expect(await state.auditCount("model.updated")).toBe(1);
        const cycle = await state.save(`/configuration/models/${model.id}`, { replacementModelConfigId: model.id }, "PATCH");
        expect(cycle.status).toBe(400);
        expect((await cycle.json()).error).toBe("INVALID_MODEL_REPLACEMENT");
    } finally { await state.close(); }
}, 30_000);

sqlTest("tool configuration audit failure preserves its binding, overrides and version; canvas chat inherits only the shared model", async () => {
    const state = await fixture();
    try {
        const provider = await state.makeProvider();
        const response = await state.save("/configuration/models", state.modelInput(provider.id));
        expect(response.status).toBe(201);
        const { model } = await response.json();
        const before = (await state.db.query("SELECT * FROM tool_api_configurations WHERE tool_key='image-edit'")).rows;
        const input = { modelConfigId: model.id, enabled: false, creditCostOverride: 0, rmbCostOverride: 0 };
        await state.failAudit("tool_api_configuration.updated");
        expect((await state.save("/configuration/tool-configurations/image-edit", input, "PUT")).status).toBe(500);
        expect((await state.db.query("SELECT * FROM tool_api_configurations WHERE tool_key='image-edit'")).rows).toEqual(before);
        expect(await state.auditCount("tool_api_configuration.updated")).toBe(0);
        await state.failAudit("");
        const changed = await state.save("/configuration/tool-configurations/image-edit", input, "PUT");
        expect(changed.status).toBe(200);
        expect((await changed.json()).tool).toMatchObject({ ...input, configurationVersion: Number(before[0]?.configuration_version ?? 0) + 1 });
        expect((await state.save("/configuration/tool-configurations/gpt-chat", { ...input, enabled: true }, "PUT")).status).toBe(200);
        const canvas = await state.save("/configuration/tool-configurations/canvas-chat", { ...input, modelConfigId: randomUUID() }, "PUT");
        expect(canvas.status).toBe(200);
        expect((await canvas.json()).tool).toMatchObject({ modelConfigId: model.id, enabled: false, creditCostOverride: 0 });
        expect((await state.db.query("SELECT model_config_id FROM tool_api_configurations WHERE tool_key='canvas-chat'")).rows[0].model_config_id).toBeNull();
    } finally { await state.close(); }
}, 30_000);

sqlTest("department reads enforce role and department scope; creation and audit are atomic", async () => {
    const state = await fixture();
    try {
        const read = (headers: Record<string, string>) => fetch(`${state.url}/departments`, { headers });
        let statementCount = state.statements.length;
        expect((await read({ "test-role": "designer" })).status).toBe(403);
        expect((await read({ "test-role": "department_admin", "test-department": "none" })).status).toBe(403);
        expect(state.statements.length).toBe(statementCount);
        const own = await read({ "test-role": "department_admin" });
        expect(own.status).toBe(200);
        expect((await own.json()).departments.map((row: { id: string }) => row.id)).toEqual([state.department]);
        const all = await (await read({ "test-role": "super_admin" })).json();
        expect(all.departments.map((row: { id: string }) => row.id)).toContain(state.department);
        expect(all.departments.map((row: { id: string }) => row.id)).toContain(state.otherDepartment);
        statementCount = state.statements.length;
        expect((await state.save("/departments", { name: "Forbidden department", code: "forbidden" }, "POST", { "test-role": "department_admin" })).status).toBe(403);
        expect(state.statements.length).toBe(statementCount);
        await state.failAudit("department.created");
        expect((await state.save("/departments", { name: "Created department", code: "created-department" })).status).toBe(500);
        expect((await state.db.query("SELECT id FROM departments WHERE code='created-department'")).rows).toEqual([]);
        expect(await state.auditCount("department.created")).toBe(0);
        await state.failAudit("");
        expect((await state.save("/departments", { name: "Created department", code: "created-department" })).status).toBe(201);
        expect(await state.auditCount("department.created")).toBe(1);
        const duplicateName = await state.save("/departments", { name: "Created department", code: "different-code" });
        expect(duplicateName.status).toBe(409);
        expect(await duplicateName.json()).toEqual({ error: "DUPLICATE", message: "部门名称已存在" });
        const duplicateCode = await state.save("/departments", { name: "Different name", code: "CREATED-DEPARTMENT" });
        expect(duplicateCode.status).toBe(409);
        expect(await duplicateCode.json()).toEqual({ error: "DUPLICATE", message: "部门编码已存在" });
    } finally { await state.close(); }
}, 30_000);

sqlTest("invalid path IDs never reach SQL and known configuration constraint errors retain the old response shape", async () => {
    const state = await fixture();
    try {
        const statementCount = state.statements.length;
        for (const [path, method] of [["/providers/not-a-uuid", "PATCH"], ["/models/not-a-uuid", "PATCH"], ["/prices/not-a-uuid/test", "POST"], ["/prices/not-a-uuid/publish", "POST"]]) {
            const response = await state.save(`/configuration${path}`, {}, method);
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: "INVALID_ID", message: "编号格式不正确" });
        }
        expect(state.statements.length).toBe(statementCount);
        const provider = await state.makeProvider();
        const duplicateProvider = await state.save("/configuration/providers", { name: "Atomic provider", protocol: "openai", baseUrl: "https://provider.example.test" });
        expect(duplicateProvider.status).toBe(409);
        expect(await duplicateProvider.json()).toEqual({ error: "DUPLICATE", message: "API 服务名称已存在" });
        for (const [input, expectedError] of [
            [state.modelInput(randomUUID()), "PROVIDER_NOT_FOUND"],
            [state.modelInput(provider.id, { workflowConfigId: randomUUID() }), "WORKFLOW_NOT_FOUND"],
            [state.modelInput(provider.id, { replacementModelConfigId: randomUUID() }), "INVALID_MODEL_REPLACEMENT"],
        ] as const) {
            const response = await state.save("/configuration/models", input);
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe(expectedError);
        }
        expect((await state.save("/configuration/models", state.modelInput(provider.id))).status).toBe(201);
        const duplicateModel = await state.save("/configuration/models", state.modelInput(provider.id));
        expect(duplicateModel.status).toBe(409);
        expect(await duplicateModel.json()).toEqual({ error: "DUPLICATE", message: "该 API 服务下的模型标识已存在" });
    } finally { await state.close(); }
}, 30_000);

sqlTest("internal AI configuration rolls back provider, workflow, model and binding when audit fails without making an upstream request", async () => {
    const state = await fixture();
    try {
        const before = await Promise.all(["providers", "workflow_configs", "model_configs", "tool_api_configurations"].map(table => state.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
        await state.failAudit("internal_ai.configured");
        expect((await state.save("/internal-ai", { seamlessUrl: "https://never-call.example.test/generate", appKey: "test-internal-key" }, "PUT")).status).toBe(500);
        const after = await Promise.all(["providers", "workflow_configs", "model_configs", "tool_api_configurations"].map(table => state.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
        expect(after.map(result => result.rows)).toEqual(before.map(result => result.rows));
        expect(await state.auditCount("internal_ai.configured")).toBe(0);
        await state.failAudit("");
        const response = await state.save("/internal-ai", { seamlessUrl: "https://never-call.example.test/generate", appKey: "test-internal-key" }, "PUT");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ seamlessUrl: "https://never-call.example.test/generate", hasAppKey: true });
        expect(await state.auditCount("internal_ai.configured")).toBe(1);
        expect((await state.db.query("SELECT id FROM providers WHERE name='内部 AI'")).rows).toHaveLength(1);
    } finally { await state.close(); }
}, 30_000);
