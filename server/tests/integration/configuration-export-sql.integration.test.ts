import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import type { AppConfig } from "../../src/config";
import type { Database } from "../../src/db";
import { createModelConfigurationRouter } from "../../src/routes/model-configuration";
import type { AuthenticatedRequest, SessionUser } from "../../src/types";
import { createIsolatedPostgres } from "../helpers/isolated-postgres";

const sqlTest = process.env.PGLITE_RUNTIME_PATH ? test : test.skip;
const forbiddenFields = new Set([
    "credentials", "encryptedcredentials", "apikey", "appkey", "secret", "token", "systemprompt", "fieldtemplate",
    "modeloverrides", "fallbackprompt", "requesttemplate", "rawresponse", "baseurl", "submitpath", "contenthash", "content",
]);
function expectNoPrivateFields(value: unknown) {
    if (Array.isArray(value)) { value.forEach(expectNoPrivateFields); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[_-]/g, "");
        expect(forbiddenFields.has(normalized)).toBe(false);
        if (normalized !== "hascredentials") expect(normalized).not.toMatch(/secret|credential|password|token|apikey|appkey|authorization|systemprompt/);
        expectNoPrivateFields(entry);
    }
}

async function fixture() {
    const postgres = await createIsolatedPostgres();
    const transactionModes: Array<{ isolation: string; readOnly: string }> = [];
    // Observe the actual PostgreSQL transaction, not just the requested BEGIN text.
    const observedDatabase = { ...postgres.db, connect: async () => {
        const client = await postgres.db.connect();
        let observed = false;
        return { query: async (sql: string, values?: unknown[]) => {
            if (!observed && /^SELECT\b/.test(sql.trim())) {
                observed = true;
                transactionModes.push((await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS \"readOnly\"")).rows[0]);
            }
            return client.query(sql, values);
        }, release: () => client.release() };
    } } as unknown as Database;
    const app = express();
    app.use((request, _response, next) => {
        (request as AuthenticatedRequest).auth = { id: randomUUID(), role: "super_admin" } as SessionUser;
        next();
    });
    app.use("/api/admin/model-configuration", createModelConfigurationRouter(observedDatabase, {} as AppConfig));
    app.use(((error, _request, response, _next) => response.status(500).json({ error: "TEST_ERROR", message: String(error) })) as ErrorRequestHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/model-configuration/export`;
    return { ...postgres, url, transactionModes, close: async () => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await postgres.close();
    } };
}

sqlTest("configuration export is a stable read-only snapshot of whitelisted bindings, switches and recipe versions", async () => {
    const state = await fixture();
    const provider = randomUUID(), otherProvider = randomUUID(), invalidProvider = randomUUID(), model = randomUUID(), otherModel = randomUUID(), version = randomUUID();
    const secrets = ["URL_USER_SECRET", "URL_PASSWORD_SECRET", "URL_PATH_SECRET", "URL_QUERY_SECRET", "URL_FRAGMENT_SECRET", "INVALID_URL_SECRET", "NON_HTTP_SECRET", "ENCRYPTED_KEY_SECRET", "SETTINGS_SECRET", "PRIVATE_RECIPE_SECRET", "SYSTEM_PROMPT_SECRET"];
    try {
        await state.db.query(`INSERT INTO providers(id,name,protocol,base_url,encrypted_credentials) VALUES
            ($1,'Provider Z','openai','https://URL_USER_SECRET:URL_PASSWORD_SECRET@provider.example.test:9443/URL_PATH_SECRET?api_key=URL_QUERY_SECRET#URL_FRAGMENT_SECRET','ENCRYPTED_KEY_SECRET'),
            ($2,'Provider A','custom','data:text/plain,NON_HTTP_SECRET',NULL),
            ($3,'Invalid provider','custom','not a URL?token=INVALID_URL_SECRET',NULL)`, [provider, otherProvider, invalidProvider]);
        await state.db.query(`INSERT INTO model_configs(id,provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled) VALUES
            ($1,$3,'Model Z','model-z',ARRAY['edit','generate'],7,0.123456,3,true),
            ($2,$3,'Model A','model-a',ARRAY['chat'],0,0,2,false)`, [model, otherModel, provider]);
        await state.db.query(`UPDATE tool_api_configurations SET model_config_id=$1,credit_cost_override=0,rmb_cost_override=0.234567,configuration_version=3,enabled=false
            WHERE tool_key='image-edit'`, [model]);
        await state.db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='gpt-chat'", [otherModel]);
        await state.db.query("UPDATE tool_api_configurations SET model_config_id=$1 WHERE tool_key='canvas-chat'", [model]);
        await state.db.query("UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='video'");
        await state.db.query("DELETE FROM tool_api_configurations WHERE tool_key='angle-control'");
        await state.db.query("UPDATE module_flags SET enabled=false WHERE module_key='image-edit'");
        await state.db.query("DELETE FROM module_flags WHERE module_key='pattern-repeat'");
        const settings = { name: "配方 Z", enabled: true, modelConfigId: otherModel, failurePolicy: "stop", apiKey: "SETTINGS_SECRET", nested: { secret: "SETTINGS_SECRET" } };
        await state.db.query(`INSERT INTO prompt_recipes(key,settings,updated_at) VALUES
            ('style-z',$1::jsonb,'2026-11-04'),('style-a','{"name":"待配置","enabled":true,"modelConfigId":null,"failurePolicy":"fallback"}','2026-11-04'),
            ('style-disabled','{"name":"停用配方","enabled":false,"modelConfigId":null,"failurePolicy":"stop"}','2026-11-04')`, [JSON.stringify(settings)]);
        await state.db.query(`INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at)
            VALUES($1,'style-z',7,'PRIVATE_RECIPE_SECRET','{"systemPrompt":"SYSTEM_PROMPT_SECRET","fieldTemplate":"PRIVATE_RECIPE_SECRET"}','private-author','2026-11-04')`, [version]);
        await state.db.query("UPDATE prompt_recipes SET current_version_id=$1 WHERE key='style-z'", [version]);
        const tables = ["providers", "model_configs", "tool_api_configurations", "module_flags", "prompt_recipes", "prompt_recipe_versions", "audit_logs"];
        const before = await Promise.all(tables.map(table => state.db.query(`SELECT row_to_json(row) AS value FROM ${table} row ORDER BY row_to_json(row)::text`).then(result => result.rows)));
        state.statements.length = 0;
        const response = await fetch(state.url);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-disposition")).toBe('attachment; filename="canvas-configuration.json"');
        expect(response.headers.get("content-type")).toContain("application/json");
        const text = await response.text();
        const body = JSON.parse(text);
        expect(body.schemaVersion).toBe(1);
        expect(Object.keys(body)).toEqual(["schemaVersion", "providers", "models", "toolConfigurations", "modules", "promptRecipes"]);
        expectNoPrivateFields(body);
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(body.providers.find((item: any) => item.id === provider)).toEqual({ id: provider, name: "Provider Z", protocol: "openai", enabled: true, hasCredentials: true, endpointOrigin: "https://provider.example.test:9443" });
        for (const id of [otherProvider, invalidProvider]) expect(body.providers.find((item: any) => item.id === id).endpointOrigin).toBeNull();
        expect(body.models.find((item: any) => item.id === model)).toMatchObject({ providerId: provider, modelId: "model-z", capabilities: ["edit", "generate"], creditCost: 7, rmbCost: 0.123456, concurrencyLimit: 3 });
        expect(body.toolConfigurations.find((item: any) => item.toolKey === "image-edit")).toMatchObject({ configured: true, modelConfigId: model, effectiveModelConfigId: model, enabled: false, creditCostOverride: 0, rmbCostOverride: 0.234567, configurationVersion: 3 });
        expect(body.toolConfigurations.find((item: any) => item.toolKey === "canvas-chat")).toMatchObject({ modelConfigId: model, effectiveModelConfigId: otherModel });
        expect(body.toolConfigurations.find((item: any) => item.toolKey === "video").allowRawPrompt).toBe(true);
        expect(body.toolConfigurations.find((item: any) => item.toolKey === "angle-control")).toMatchObject({ configured: false, modelConfigId: null, enabled: true, configurationVersion: 0 });
        expect(body.modules.find((item: any) => item.moduleKey === "image-edit")).toMatchObject({ configured: true, enabled: false });
        expect(body.modules.find((item: any) => item.moduleKey === "pattern-repeat")).toMatchObject({ configured: false, enabled: false });
        expect(body.promptRecipes).toEqual([
            { key: "style-a", name: "待配置", enabled: true, modelConfigId: null, failurePolicy: "fallback", currentVersionId: null, currentVersion: null, status: "unconfigured" },
            { key: "style-disabled", name: "停用配方", enabled: false, modelConfigId: null, failurePolicy: "stop", currentVersionId: null, currentVersion: null, status: "disabled" },
            { key: "style-z", name: "配方 Z", enabled: true, modelConfigId: otherModel, failurePolicy: "stop", currentVersionId: version, currentVersion: 7, status: "active" },
        ]);
        for (const [section, key] of [["providers", "id"], ["models", "id"], ["toolConfigurations", "toolKey"], ["modules", "moduleKey"], ["promptRecipes", "key"]]) {
            const keys = body[section!].map((item: any) => item[key!]);
            expect(keys).toEqual([...keys].sort());
        }
        const reads = [...state.statements];
        expect(reads[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        expect(reads.at(-1)).toBe("COMMIT");
        expect(reads.slice(1, -1).every(sql => /^SELECT\b/.test(sql.trim()))).toBe(true);
        expect(state.transactionModes).toEqual([{ isolation: "repeatable read", readOnly: "on" }]);
        const after = await Promise.all(tables.map(table => state.db.query(`SELECT row_to_json(row) AS value FROM ${table} row ORDER BY row_to_json(row)::text`).then(result => result.rows)));
        expect(after).toEqual(before);
        // Metadata and unordered capabilities must not create staging/prod diff noise.
        await state.db.query("UPDATE providers SET updated_at=now()+interval '1 day'");
        await state.db.query("UPDATE model_configs SET updated_at=now()+interval '1 day',capabilities=ARRAY['generate','edit'] WHERE id=$1", [model]);
        await state.db.query("UPDATE prompt_recipes SET updated_at='2099-01-01'");
        expect(await fetch(state.url).then(result => result.text())).toBe(text);
        expect(await fetch(`${state.url}?includeSecrets=true&raw=true`).then(result => result.text())).toBe(text);
        await state.db.query("UPDATE module_flags SET enabled=true WHERE module_key='image-edit'");
        const changed = await fetch(state.url).then(result => result.json());
        expect(changed.modules.find((item: any) => item.moduleKey === "image-edit").enabled).toBe(true);
        expect(changed).not.toEqual(body);
    } finally { await state.close(); }
}, 60_000);

sqlTest("configuration export rolls back a failed SQL read and releases its snapshot before a subsequent download", async () => {
    const state = await fixture();
    try {
        await state.db.query("ALTER TABLE prompt_recipe_versions RENAME COLUMN version TO unavailable_version");
        state.statements.length = 0;
        const failed = await fetch(state.url);
        expect(failed.status).toBe(500);
        expect(await failed.json()).not.toHaveProperty("providers");
        expect(state.statements.at(-1)).toBe("ROLLBACK");
        const mode = await state.db.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS \"readOnly\"");
        expect(mode.rows).toEqual([{ isolation: "read committed", readOnly: "off" }]);
        await state.db.query("ALTER TABLE prompt_recipe_versions RENAME COLUMN unavailable_version TO version");
        const recovered = await fetch(state.url);
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toMatchObject({ schemaVersion: 1, providers: [], models: [], promptRecipes: [] });
        expect(state.transactionModes).toEqual([
            { isolation: "repeatable read", readOnly: "on" }, { isolation: "repeatable read", readOnly: "on" },
        ]);
    } finally { await state.close(); }
}, 60_000);
