import { afterEach, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { MARK_IMAGE_BASE_URL, MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import type { AppConfig } from "../src/config";
import type { Database } from "../src/db";
import { createModelConfigurationRouter } from "../src/routes/model-configuration";
import { decryptSecret } from "../src/security";

const servers: Server[] = [];
const key = Buffer.alloc(32, 8).toString("base64");
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
});

async function fixture(role = "super_admin", encryptionKey: string | undefined = key) {
  let provider: Record<string, any> | null = null;
  let models: Record<string, any>[] = [];
  let chatBinding = { modelConfigId: null as string | null, configurationVersion: 1, updatedBy: null as string | null };
  let snapshot: { provider: Record<string, any> | null; models: Record<string, any>[]; chatBinding: typeof chatBinding } | null = null;
  const audit: unknown[] = [], statements: string[] = [];
  let failAtModel = "";
  const query = async (sql: string, values: any[] = []) => {
    statements.push(sql);
    if (sql === "BEGIN") { snapshot = structuredClone({ provider, models, chatBinding }); return { rows: [] }; }
    if (sql === "COMMIT") { snapshot = null; return { rows: [] }; }
    if (sql === "ROLLBACK") { if (snapshot) { provider = snapshot.provider; models = snapshot.models; chatBinding = snapshot.chatBinding; } snapshot = null; return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT") && sql.includes("FROM providers")) {
      expect(values[0]).toBe(MARK_IMAGE_PROVIDER_ID);
      if (!provider) return { rows: [] };
      const { encryptedCredentials, ...safe } = provider;
      return { rows: [{ ...safe, hasCredentials: Boolean(encryptedCredentials) }] };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM model_configs")) {
      expect(values[0]).toBe(MARK_IMAGE_PROVIDER_ID);
      return { rows: models.map(({ providerId, ...model }) => model) };
    }
    if (sql.startsWith("INSERT INTO providers")) {
      const [id, name, baseUrl, enabled, encryptedCredentials] = values;
      expect(id).toBe(MARK_IMAGE_PROVIDER_ID);
      provider = { id, name, baseUrl, enabled, protocol: "apimart", encryptedCredentials: encryptedCredentials ?? provider?.encryptedCredentials };
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO model_configs")) {
      const [providerId, name, modelId, capabilities, creditCost, rmbCost, concurrencyLimit, enabled] = values;
      expect(providerId).toBe(MARK_IMAGE_PROVIDER_ID);
      if (modelId === failAtModel) throw new Error("fixture insert failure");
      const existing = models.find(model => model.modelId === modelId);
      const model = { id: existing?.id || crypto.randomUUID(), providerId, name, modelId, capabilities, creditCost, rmbCost, concurrencyLimit, enabled };
      models = [...models.filter(item => item.modelId !== modelId), model];
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO tool_api_configurations")) {
      expect(values).toEqual([MARK_IMAGE_PROVIDER_ID, "claude-sonnet-5-5"]);
      expect(sql).toContain("tool_api_configurations.model_config_id IS NULL");
      expect(sql).toContain("tool_api_configurations.updated_by IS NULL");
      expect(sql).toContain("tool_api_configurations.configuration_version=1");
      const selected = models.find(model => model.providerId === values[0] && model.modelId === values[1]);
      if (selected && !chatBinding.modelConfigId && !chatBinding.updatedBy && chatBinding.configurationVersion === 1) {
        chatBinding = { ...chatBinding, modelConfigId: selected.id, configurationVersion: 2 };
      }
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO audit_logs")) { audit.push(values); return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Database;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: "10000000-0000-4000-8000-000000000001", role } }); next(); });
  app.use("/mark", createModelConfigurationRouter(db, { PROVIDER_ENCRYPTION_KEY: encryptionKey } as AppConfig));
  app.use(((error, _request, response, _next) => { response.status(error.name === "ZodError" ? 400 : 500).json({ message: error.message }); }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/mark/mark-images`;
  return { url, state: () => ({ provider, models, chatBinding }), setChatBinding: (value: typeof chatBinding) => { chatBinding = value; }, audit, statements, fail: (modelId: string) => { failAtModel = modelId; } };
}
const input = () => ({ baseUrl: MARK_IMAGE_BASE_URL, enabled: true, apiKey: "fixture-mark-key", models: MARK_PLATFORM_MODELS.map(model => ({ modelId: model.modelId, enabled: true, creditCost: 8, rmbCost: 0, concurrencyLimit: 2 })) });
const save = (url: string, body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("separate Mark configuration is atomic, idempotent, and never returns plaintext or ciphertext", async () => {
  const f = await fixture();
  expect(await (await fetch(f.url)).json()).toEqual({ provider: null, models: [] });
  const response = await save(f.url, input());
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.provider).toMatchObject({ id: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", hasCredentials: true });
  expect(data.models.map((model: any) => model.name)).toEqual(MARK_PLATFORM_MODELS.map(model => model.name));
  expect(f.state().models.map(model => model.capabilities)).toEqual(MARK_PLATFORM_MODELS.map(model => [...model.capabilities]));
  expect(f.state().chatBinding.modelConfigId).toBe(data.models.find((model: any) => model.modelId === "claude-sonnet-5-5").id);
  const encrypted = f.state().provider!.encryptedCredentials;
  expect(JSON.parse(decryptSecret(encrypted, key))).toEqual({ apiKey: "fixture-mark-key" });
  expect(JSON.stringify(data)).not.toContain(encrypted);
  expect(JSON.stringify(data)).not.toContain("fixture-mark-key");
  const again = await save(f.url, { ...input(), apiKey: "", enabled: false });
  expect(again.status).toBe(200);
  expect((await again.json()).models.map((model: any) => model.id)).toEqual(data.models.map((model: any) => model.id));
  expect(f.state().provider!.encryptedCredentials).toBe(encrypted);
  expect(f.state().provider!.enabled).toBe(false);
  expect(f.state().models).toHaveLength(MARK_PLATFORM_MODELS.length);
  expect(JSON.stringify(f.audit)).not.toContain("fixture-mark-key");
});

test("APIMart saves do not overwrite an explicit shared model selection or clearing", async () => {
  const f = await fixture();
  expect((await save(f.url, input())).status).toBe(200);
  for (const modelConfigId of [f.state().models[0]!.id, null]) {
    const selected = { modelConfigId, configurationVersion: 3, updatedBy: "administrator" };
    f.setChatBinding(selected);
    expect((await save(f.url, { ...input(), apiKey: "" })).status).toBe(200);
    expect(f.state().chatBinding).toEqual(selected);
  }
});

test.each(["designer", "department_admin"])("%s cannot read or write the dedicated key", async role => {
  const f = await fixture(role);
  expect((await fetch(f.url)).status).toBe(403);
  expect((await save(f.url, input())).status).toBe(403);
  expect(f.statements).toHaveLength(0);
});

test("key is required on first save and host changes; encryption key is required before persistence", async () => {
  const f = await fixture();
  expect((await save(f.url, { ...input(), apiKey: "" })).status).toBe(400);
  expect(f.state().provider).toBeNull();
  expect((await save(f.url, input())).status).toBe(200);
  expect((await save(f.url, { ...input(), apiKey: "", baseUrl: "https://other.example.test/v1" })).status).toBe(400);
  expect(f.state().provider!.baseUrl).toBe(MARK_IMAGE_BASE_URL);
  const missing = await fixture("super_admin", "");
  expect((await save(missing.url, input())).status).toBe(503);
  expect(missing.statements).toHaveLength(0);
});

test("invalid models, duplicate IDs, bad parameters and unsafe base URLs are rejected before writes", async () => {
  const f = await fixture();
  const original = input();
  for (const body of [
    { ...original, models: original.models.slice(0, 2) },
    { ...original, models: [original.models[0], original.models[0], ...original.models.slice(2)] },
    { ...original, models: original.models.map(model => ({ ...model, modelId: "gemini-nano-banana-2.1-ext" })) },
    { ...original, models: original.models.map(model => ({ ...model, concurrencyLimit: 0 })) },
    ...["http://example.test/v1", "https://127.0.0.1/v1", "https://example.test/v1?key=bad", "https://example.test/images/generations"].map(baseUrl => ({ ...original, baseUrl })),
  ]) expect((await save(f.url, body)).status).toBe(400);
  expect(f.statements).toHaveLength(0);
});

test("model insertion failure rolls back provider and model changes together", async () => {
  const f = await fixture();
  f.fail(MARK_PLATFORM_MODELS[4].modelId);
  expect((await save(f.url, input())).status).toBe(500);
  expect(f.state()).toEqual({ provider: null, models: [], chatBinding: { modelConfigId: null, configurationVersion: 1, updatedBy: null } });
  expect(f.statements).toContain("ROLLBACK");
  expect(f.audit).toHaveLength(0);
});
