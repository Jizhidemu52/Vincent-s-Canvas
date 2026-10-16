/** Opt-in local QA: production routes + actual PostgreSQL SQL engine, isolated from user data.
 * Prepare: npm install --prefix output/mark-admin-qa/runtime --no-save @electric-sql/pglite
 * Run from server: bun build scripts/mark-admin-persistence-qa.ts --target=node --outfile ../output/mark-admin-qa/server.mjs
 * Then: node --max-old-space-size=8192 ../output/mark-admin-qa/server.mjs --serve
 * Upgrade QA reuses the existing eight-model pgdata fixture; it never replaces that database.
 * No upstream provider requests are made. Only deliberately fake QA keys are accepted.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import { createModuleFlagsRouter } from "../src/routes/module-flags";
import { decryptSecret } from "../src/security";
import { MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID, MARK_IMAGE_BASE_URL } from "../../shared/mark-image-models";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";

if (!process.argv.includes("--serve")) throw Error("Explicit --serve is required for isolated local QA");
const directory = resolve("../output/mark-admin-qa");
await mkdir(directory, { recursive: true });
const requireQa = createRequire(resolve(directory, "runtime/package.json"));
const { PGlite } = requireQa("@electric-sql/pglite");
const { pgcrypto } = requireQa("@electric-sql/pglite/contrib/pgcrypto");
const { citext } = requireQa("@electric-sql/pglite/contrib/citext");
let database = new PGlite(resolve(directory, "pgdata"), { extensions: { pgcrypto, citext } });
await database.waitReady;
const modelTableExists = (await database.query("SELECT to_regclass('public.model_configs') AS relation")).rows[0].relation;
const originalModelRows: Array<{ id: string; modelId: string }> = modelTableExists
  ? (await database.query('SELECT id,model_id AS "modelId" FROM model_configs WHERE provider_id=$1 ORDER BY model_id', [MARK_IMAGE_PROVIDER_ID])).rows
  : [];
const legacyModelIds: string[] = MARK_PLATFORM_MODELS.slice(0, 5).map(model => model.modelId);
const originalFive = originalModelRows.filter(model => legacyModelIds.includes(model.modelId));
assert.equal(originalFive.length, 5, "This upgrade QA must reuse the existing isolated five-model database, not a fresh replacement");
const originalEight = originalModelRows.filter(model => MARK_PLATFORM_MODELS.slice(0, 8).some(preset => preset.modelId === model.modelId));
assert.equal(originalEight.length, 8, "The Nano2 upgrade must retain the existing eight-model fixture");
assert.equal(MARK_PLATFORM_MODELS.length, 10);
assert.deepEqual(MARK_PLATFORM_MODELS.filter(model => !model.defaultEnabled).map(model => model.modelId), ["grok-imagine-image-2.0"]);
assert.equal(MARK_PLATFORM_MODELS.at(-1)?.modelId, "claude-sonnet-5-5");
await database.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
const applied = new Set((await database.query("SELECT name FROM schema_migrations")).rows.map((row: any) => row.name));
for (const name of (await readdir("src/migrations")).filter(name => name.endsWith(".sql")).sort()) {
  if (applied.has(name)) continue;
  await database.exec("BEGIN");
  try {
    await database.exec(await readFile(resolve("src/migrations", name), "utf8"));
    await database.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    await database.exec("COMMIT");
  } catch (error) { await database.exec("ROLLBACK"); throw error; }
}
const actorId = "80000000-0000-4000-8000-000000000001";
await database.query("INSERT INTO users(id,username,display_name,role,must_change_password) VALUES($1,'mark-qa-admin','Mark QA Admin','super_admin',false) ON CONFLICT(id) DO NOTHING", [actorId]);
const encryptionKey = Buffer.alloc(32, 73).toString("base64");
const query = async (sql: string, values: unknown[] = []) => {
  const result = await database.query(sql, values);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
const app = express();
app.use(express.json());
// This QA-only entrypoint is bound to loopback and never imported by production.
app.use((request, response, next) => {
  if (request.method === "PUT" && request.body?.apiKey && !String(request.body.apiKey).startsWith("fixture-mark-")) {
    response.status(400).json({ message: "QA accepts only fake fixture-mark-* keys" }); return;
  }
  Object.assign(request, { auth: { id: actorId, role: request.headers["x-qa-role"] === "designer" ? "designer" : "super_admin", departmentId: null } }); next();
});
app.use("/api/admin/model-configuration", createModelConfigurationRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
app.use("/api/models", createPublicModelRouter(db));
app.use("/api/modules", createModuleFlagsRouter(db));
app.use((error: any, _request: any, response: any, _next: any) => { response.status(error.name === "ZodError" ? 400 : 500).json({ message: error.message }); });
const server = app.listen(3102, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const url = "http://127.0.0.1:3102/api/admin/model-configuration/mark-images";
// Deliberately enable Grok in this persistence fixture to verify an explicit saved
// choice survives, even though brand-new admin forms default Grok to disabled.
const input = { baseUrl: MARK_IMAGE_BASE_URL, apiKey: "fixture-mark-persistence", enabled: true,
  models: MARK_PLATFORM_MODELS.map((model, index) => ({ modelId: model.modelId, enabled: true, creditCost: index + 2, rmbCost: index / 10, concurrencyLimit: index + 1 })) };
const put = (body: unknown, role?: string) => fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...(role ? { "x-qa-role": role } : {}) }, body: JSON.stringify(body) });
assert.equal((await put(input, "designer")).status, 403);
assert.equal((await fetch(url, { headers: { "x-qa-role": "designer" } })).status, 403);
const firstResponse = await put(input);
const first = await firstResponse.json();
assert.equal(firstResponse.status, 200, JSON.stringify(first));
assert.equal(first.models.length, MARK_PLATFORM_MODELS.length);
for (const previous of originalModelRows) {
  assert.equal(first.models.find((model: any) => model.modelId === previous.modelId)?.id, previous.id, `Existing UUID changed for ${previous.modelId}`);
}
const assertNoCredentialLeak = (value: unknown) => {
  const json = JSON.stringify(value);
  assert.equal(/fixture-mark-[a-zA-Z0-9-]+/.test(json), false, "QA credentials must not appear in API or audit output");
  assert.equal(/encrypted_credentials|encryptedCredentials/.test(json), false, "Encrypted credential fields must not appear in API or audit output");
};
assertNoCredentialLeak(first);
const encryptedBefore = (await query("SELECT encrypted_credentials FROM providers WHERE id=$1", [MARK_IMAGE_PROVIDER_ID])).rows[0].encrypted_credentials;
assert.equal(JSON.parse(decryptSecret(encryptedBefore, encryptionKey)).apiKey, input.apiKey);
assert.ok(!JSON.stringify(first).includes(input.apiKey));
assert.ok(!JSON.stringify(first).includes(encryptedBefore));
assert.equal((await put({ ...input, apiKey: "", enabled: false })).status, 200);
assert.equal((await query("SELECT encrypted_credentials FROM providers WHERE id=$1", [MARK_IMAGE_PROVIDER_ID])).rows[0].encrypted_credentials, encryptedBefore);
assert.equal((await put({ ...input, apiKey: "" })).status, 200);
const persistedModelSelect = "SELECT id,model_id,name,capabilities,enabled,credit_cost,rmb_cost::float8 AS rmb_cost,concurrency_limit FROM model_configs WHERE provider_id=$1 ORDER BY model_id";
const before = (await query(persistedModelSelect, [MARK_IMAGE_PROVIDER_ID])).rows;
assert.equal(before.length, MARK_PLATFORM_MODELS.length);
for (const preset of MARK_PLATFORM_MODELS) {
  const saved = before.find((model: any) => model.model_id === preset.modelId);
  const expected = input.models.find(model => model.modelId === preset.modelId)!;
  assert.deepEqual(saved?.capabilities, [...preset.capabilities]);
  assert.equal(saved.name, preset.name);
  assert.equal(saved.enabled, expected.enabled);
  assert.equal(saved.credit_cost, expected.creditCost);
  assert.equal(saved.rmb_cost, expected.rmbCost);
  assert.equal(saved.concurrency_limit, expected.concurrencyLimit);
}
assert.equal((await put({ ...input, apiKey: "", baseUrl: "https://other.example.test/v1" })).status, 400);
const mjModuleBefore = (await query("SELECT module_key,enabled FROM module_flags WHERE module_key='midjourney-blend'")).rows;
const mjBindingBefore = (await query("SELECT tool_key,model_config_id,enabled,configuration_version,credit_cost_override,rmb_cost_override FROM tool_api_configurations WHERE tool_key='midjourney-blend'")).rows;
assert.equal(mjModuleBefore.length, 1, "027 must create an actual MJ module row");
assert.equal(mjBindingBefore.length, 1, "027 must create an actual MJ tool binding row, not only a catalog fallback");
assert.equal(mjModuleBefore[0].enabled, true);
assert.equal(mjBindingBefore[0].enabled, true);
assert.ok(mjBindingBefore[0].configuration_version >= 1);
// Close and reopen the database, then call the same actual HTTP route again.
await database.close();
database = new PGlite(resolve(directory, "pgdata"), { extensions: { pgcrypto, citext } });
await database.waitReady;
const after = (await query(persistedModelSelect, [MARK_IMAGE_PROVIDER_ID])).rows;
assert.deepEqual(after, before);
const reloadedResponse = await fetch(url);
assert.equal(reloadedResponse.status, 200);
const reloaded = await reloadedResponse.json();
assertNoCredentialLeak(reloaded);
assert.equal(reloaded.models.length, MARK_PLATFORM_MODELS.length);
assert.deepEqual((await query("SELECT module_key,enabled FROM module_flags WHERE module_key='midjourney-blend'")).rows, mjModuleBefore);
assert.deepEqual((await query("SELECT tool_key,model_config_id,enabled,configuration_version,credit_cost_override,rmb_cost_override FROM tool_api_configurations WHERE tool_key='midjourney-blend'")).rows, mjBindingBefore);
const publicModelsResponse = await fetch("http://127.0.0.1:3102/api/models");
assert.equal(publicModelsResponse.status, 200);
const publicModels = await publicModelsResponse.json();
assertNoCredentialLeak(publicModels);
const publicMjTool = publicModels.tools.find((tool: any) => tool.toolKey === "midjourney-blend");
assert.ok(publicMjTool);
assert.equal(publicMjTool.configurationVersion, mjBindingBefore[0].configuration_version);
assert.equal(publicMjTool.modelConfigId, mjBindingBefore[0].model_config_id);
const moduleResponse = await fetch("http://127.0.0.1:3102/api/modules");
assert.equal(moduleResponse.status, 200);
const modules = await moduleResponse.json();
assert.equal(modules.modules.find((module: any) => module.moduleKey === "midjourney-blend")?.enabled, true);
const toolResponse = await fetch("http://127.0.0.1:3102/api/admin/model-configuration/tool-configurations");
assert.equal(toolResponse.status, 200);
const toolConfigurations = await toolResponse.json();
assertNoCredentialLeak(toolConfigurations);
assert.equal(toolConfigurations.tools.find((tool: any) => tool.toolKey === "midjourney-blend")?.configurationVersion, mjBindingBefore[0].configuration_version);
const audit = (await query("SELECT action,detail FROM audit_logs WHERE target_id=$1", [MARK_IMAGE_PROVIDER_ID])).rows;
assert.ok(audit.length >= 3);
assertNoCredentialLeak(audit);
const report = { status: "pass", engine: "PostgreSQL via PGlite (isolated QA only)", migrations: (await query("SELECT name FROM schema_migrations ORDER BY name")).rows,
  upgrade: { existingModelCount: originalModelRows.length, originalFive, originalEight, currentModelCount: after.length, existingFiveUuidsRetained: true, allExistingUuidsRetained: true },
  catalogDefaults: MARK_PLATFORM_MODELS.map(({ modelId, defaultEnabled, description }) => ({ modelId, defaultEnabled, usage: description })),
  explicitGrokEnabledFixturePreserved: after.find((model: any) => model.model_id === "grok-imagine-image-2.0")?.enabled === true,
  persistedModels: after,
  mjModule: mjModuleBefore[0], mjBinding: mjBindingBefore[0],
  checks: ["real SQL migrations including MJ module/binding", "designer read/write forbidden", `${MARK_PLATFORM_MODELS.length} capability-specific models`, "all original eight UUIDs retained during Nano2 expansion", "catalog defaults only Grok off; explicit enabled Grok fixture preserved", "encrypted key persisted", "blank key retained", "idempotent UUIDs", "database reopen persistence", "MJ module and persisted binding visible through formal APIs", "host change requires key", "API and audit exclude all fixture keys"], upstreamCalls: 0 };
await writeFile(resolve(directory, "persistence-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ready: true, url, checks: report.checks, upstreamCalls: 0 }));
