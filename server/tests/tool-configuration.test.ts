import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import { moduleKeys, toolDefinitions } from "../../shared/feature-catalog";
import { loadTaskPriceSnapshot, reserveCredits } from "../src/billing";
import type { Database } from "../src/db";
import { createModelConfigurationRouter, createPublicModelRouter } from "../src/routes/model-configuration";
import { createTasksRouter } from "../src/routes/tasks";
import { createChatRouter } from "../src/routes/chat";
import { normalizeTaskTool, resolveToolExecution, type ToolConfiguration } from "../src/tool-configuration";
import { resolveCurrentPromptPricing } from "../src/prompt-templates";

const modelId = "10000000-0000-4000-8000-000000000001";
const secondModelId = "10000000-0000-4000-8000-000000000002";
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });

function fixture() {
  const configurations = new Map<string, ToolConfiguration>();
  const flags = new Map<string, boolean>(moduleKeys.map(key => [key, true]));
  const models = [modelId, secondModelId].map((id, i) => ({
    id, name: `model ${i}`, modelId: `uncurated-model-${i}`, publicNumber: i + 1,
    enabled: true, providerEnabled: true, workflowConfigId: null as string | null, workflowEnabled: true,
    capabilities: ["generate", "edit", "video", "audio", "chat"],
    creditCost: 4, rmbCost: 0.4, credit_cost: 4, rmb_cost: "0.4",
    providerName: "Other provider", protocol: "openai", providerBaseUrl: "https://provider.invalid",
  }));
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const reservations: unknown[][] = [];
  const tasks = new Map<string, { id: string }>();
  let queues = 0;
  let videoPreflights = 0;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM model_presentation_settings")) return { rows: [] };
      if (sql.includes("FROM module_flags")) return { rows: [{ enabled: flags.get(String(values[0])) }] };
      if (sql.startsWith("INSERT INTO tool_api_configurations")) {
        const [key, modelConfigId, enabled, , creditCostOverride, rmbCostOverride] = values as [ToolConfiguration["toolKey"], string | null, boolean, unknown, number | null, number | null];
        const row = { toolKey: key, modelConfigId, enabled, creditCostOverride, rmbCostOverride, configurationVersion: (configurations.get(key)?.configurationVersion ?? 0) + 1 };
        configurations.set(key, row);
        return { rows: [row] };
      }
      if (sql.includes("FROM tool_api_configurations")) return { rows: values.length ? [configurations.get(String(values[0]))].filter(Boolean) : [...configurations.values()] };
      if (sql.includes("FROM pricing_rule_versions")) return { rows: [{ operationType: values[0] ?? "inpaint", credits: 8, rmbCost: 0.8, rmb_cost: "0.8", version: 3 }] };
      if (sql.includes("FROM model_configs")) {
        let selected = values.length ? models.filter(model => model.id === values[0] || model.modelId === values[0]) : models;
        if (sql.includes("m.enabled=true")) selected = selected.filter(model => model.enabled && model.providerEnabled && (!model.workflowConfigId || model.workflowEnabled));
        return { rows: selected };
      }
      if (sql.startsWith("INSERT INTO audit_logs")) return { rows: [] };
      if (sql.startsWith("INSERT INTO tasks")) { tasks.set(String(values[1]), { id: String(values[0]) }); return { rows: [{ id: values[0] }] }; }
      if (sql.startsWith("UPDATE tasks") || sql.startsWith("UPDATE batch_tasks")) return { rows: [] };
      if (sql.startsWith("INSERT INTO batch_tasks")) return { rows: [{ id: values[0] }] };
      if (sql.includes("COUNT(*)::int total")) return { rows: [{ total: tasks.size, waiting: tasks.size, success: 0, failed: 0, cancelled: 0, paused: 0, processing: 0 }] };
      if (sql.includes("FROM credit_reservations")) return { rows: [] };
      if (sql.includes("FROM users")) return { rows: [{ department_id: null }] };
      if (sql.startsWith("INSERT INTO credit_reservations")) { reservations.push(values); return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const db = { ...client, connect: async () => client } as unknown as Database;
  const cache = { zAdd: async () => { queues++; return 1; } };
  const bind = (key: ToolConfiguration["toolKey"], values: Partial<ToolConfiguration> = {}) => {
    const row = { toolKey: key, modelConfigId: modelId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1, ...values };
    configurations.set(key, row);
    return row;
  };
  return { db, cache, flags, models, configurations, statements, reservations, bind, get queues() { return queues; }, get videoPreflights() { return videoPreflights; }, preflight: async () => { videoPreflights++; return { normalized: {} }; } };
}

async function serve(state = fixture()) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: modelId, role: "super_admin", departmentId: null } }); next(); });
  app.use("/admin", createModelConfigurationRouter(state.db, {} as never));
  app.use("/models", createPublicModelRouter(state.db));
  app.use("/tasks", createTasksRouter(state.db, state.cache as never, false, state.preflight as never));
  app.use("/chat", createChatRouter(state.db, {} as never));
  app.use(((error, _request, response, _next) => { response.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: error.code, message: error.message }); }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  return { ...state, url: `http://127.0.0.1:${address.port}`, state };
}
const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("formal catalog configuration", () => {
  test("Blend binding accepts only the Blend model while canvas-image keeps that choice", async () => {
    const state = fixture();
    state.models[0]!.modelId = "midjourney-blend";
    state.models[0]!.capabilities = ["generate"];
    const { url } = await serve(state);
    const values = { modelConfigId: secondModelId, enabled: true, creditCostOverride: null, rmbCostOverride: null };
    const rejected = await post(`${url}/admin/tool-configurations/midjourney-blend`, values, "PUT");
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe("TOOL_MODEL_MISMATCH");
    expect(state.configurations.has("midjourney-blend")).toBe(false);
    const accepted = await post(`${url}/admin/tool-configurations/midjourney-blend`, { ...values, modelConfigId: modelId }, "PUT");
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).tool.modelConfigId).toBe(modelId);
    expect((await post(`${url}/admin/tool-configurations/canvas-image`, { ...values, modelConfigId: modelId }, "PUT")).status).toBe(200);
  });

  test("admin/public expose every catalog tool including disabled and unbound, and retain explicitly bound uncurated models", async () => {
    const state = fixture();
    state.models[0]!.capabilities = ["generate", "edit"];
    state.bind("image", { enabled: false });
    state.bind("canvas-image", { modelConfigId: null });
    state.bind("image-edit");
    const { url } = await serve(state);
    const admin = await (await fetch(`${url}/admin/tool-configurations`)).json();
    const publicResult = await (await fetch(`${url}/models`)).json();
    for (const body of [admin, publicResult]) {
      expect(body.tools).toHaveLength(toolDefinitions.length);
      expect(body.tools.map((item: { toolKey: string }) => item.toolKey)).toEqual(toolDefinitions.map(item => item.toolKey));
      expect(body.tools.find((item: { toolKey: string }) => item.toolKey === "image")).toMatchObject({ enabled: false, modelConfigId: modelId });
      expect(body.tools.find((item: { toolKey: string }) => item.toolKey === "canvas-image")).toMatchObject({ enabled: true, modelConfigId: null, parent: "canvas" });
      expect(body.tools.find((item: { toolKey: string }) => item.toolKey === "angle-control")).toMatchObject({ enabled: true, modelConfigId: null, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 0 });
    }
    expect(publicResult.models.some((model: { id: string }) => model.id === modelId)).toBe(true);
    expect(JSON.stringify(publicResult)).not.toContain("providerBaseUrl");
    expect(JSON.stringify(publicResult)).not.toContain("encrypted_credentials");
  });

  test("two tools sharing one model save independent zero overrides without mutating model/provider/global prices", async () => {
    const { url, state } = await serve();
    const modelsBefore = JSON.stringify(state.models);
    state.bind("angle-control");
    const saved = await post(`${url}/admin/tool-configurations/image-edit`, { modelConfigId: modelId, enabled: true, creditCostOverride: 0, rmbCostOverride: 0 }, "PUT");
    expect(saved.status).toBe(200);
    expect((await saved.json()).tool).toMatchObject({ creditCostOverride: 0, rmbCostOverride: 0, configurationVersion: 1 });
    const cleared = await post(`${url}/admin/tool-configurations/image-edit`, { modelConfigId: null, enabled: false, creditCostOverride: null, rmbCostOverride: null }, "PUT");
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).tool).toMatchObject({ modelConfigId: null, enabled: false, configurationVersion: 2 });
    expect(state.configurations.get("angle-control")).toMatchObject({ enabled: true, modelConfigId: modelId, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
    expect(JSON.stringify(state.models)).toBe(modelsBefore);
    expect(state.statements.some(({ sql }) => /(?:UPDATE|INSERT INTO) (?:model_configs|providers|pricing_rule_versions)/.test(sql))).toBe(false);
    expect((await post(`${url}/admin/tool-configurations/image-edit`, { modelConfigId: modelId, enabled: true, creditCostOverride: -1, rmbCostOverride: 0 }, "PUT")).status).toBe(400);
  });

  test("migration constraints and non-destructive seeds exactly cover the shared catalog", () => {
    const original = readFileSync(new URL("../src/migrations/026_formal_module_configuration.sql", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../src/migrations/027_midjourney_blend_module.sql", import.meta.url), "utf8");
    const keys = (value: string) => [...value.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
    const toolCheck = /CHECK \(tool_key IN \(([\s\S]*?)\)\)/.exec(migration)![1]!;
    const moduleCheck = /CHECK \(module_key IN \(([\s\S]*?)\)\)/.exec(migration)![1]!;
    const arrays = [...original.matchAll(/unnest\(ARRAY\[([\s\S]*?)\]\)/g)];
    expect(keys(toolCheck)).toEqual(toolDefinitions.map(tool => tool.toolKey).sort());
    expect(keys(moduleCheck)).toEqual([...moduleKeys].sort());
    expect(keys(arrays[0]![1]!)).toEqual(moduleKeys.filter(key => key !== "midjourney-blend").sort());
    expect(keys(arrays[1]![1]!)).toEqual(toolDefinitions.map(tool => tool.toolKey).filter(key => key !== "midjourney-blend").sort());
    expect(migration).toContain("ON CONFLICT(module_key) DO NOTHING");
    expect(migration).toContain("ON CONFLICT(tool_key) DO NOTHING");
    expect(original).toContain("ALTER COLUMN model_config_id DROP NOT NULL");
    expect(original).not.toMatch(/UPDATE\s+(?:model_configs|pricing_rule_versions)/);
  });
});

describe("authoritative scoped execution", () => {
  test("Blend rejects wrong chosen or bound models before task reservation and permits canvas-image", async () => {
    const state = fixture();
    state.models[0]!.modelId = "midjourney-blend";
    state.models[0]!.capabilities = ["generate"];
    const input = { operationType: "image_generation", toolKey: "midjourney-blend", modelConfigId: secondModelId };
    await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "TOOL_MODEL_MISMATCH" });
    expect(await resolveToolExecution(state.db, { ...input, modelConfigId: modelId })).toMatchObject({ modelConfigId: modelId });
    expect(await resolveToolExecution(state.db, { ...input, toolKey: "canvas-image", modelConfigId: modelId })).toMatchObject({ modelConfigId: modelId });
    state.bind("midjourney-blend", { modelConfigId: secondModelId });
    await expect(resolveToolExecution(state.db, { operationType: "image_generation", toolKey: "midjourney-blend" })).rejects.toMatchObject({ code: "TOOL_MODEL_MISMATCH" });
    const { url } = await serve(state);
    const rejected = await post(`${url}/tasks`, { ...input, requestId: "blend-wrong-model", projectId: "canvas", prompt: "Blend", sourceUrls: ["first", "second"] });
    expect(rejected.status).toBe(400); expect((await rejected.json()).error).toBe("TOOL_MODEL_MISMATCH");
    expect(state.queues).toBe(0); expect(state.reservations).toHaveLength(0);
  });

  test("normalizes only known legacy sources and rejects explicit unknown/mismatched operations", () => {
    expect(normalizeTaskTool({ operationType: "image_generation", parameters: { tool: "image-generation" } })).toBe("image");
    expect(normalizeTaskTool({ operationType: "inpaint", parameters: { tool: "agent-direct" } })).toBe("canvas-edit");
    expect(() => normalizeTaskTool({ operationType: "inpaint", toolKey: "typo" })).toThrow("未知功能");
    expect(() => normalizeTaskTool({ operationType: "video_generation", toolKey: "canvas-edit" })).toThrow("不支持当前操作");
  });

  test("unbound uses the selected enabled model; bound requires a refresh on mismatch and works without a client model", async () => {
    const state = fixture();
    expect(await resolveToolExecution(state.db, { operationType: "inpaint", toolKey: "image-edit", modelConfigId: secondModelId })).toMatchObject({ modelConfigId: secondModelId, configurationVersion: 0 });
    state.bind("image-edit");
    expect(await resolveToolExecution(state.db, { operationType: "inpaint", toolKey: "image-edit" })).toMatchObject({ modelConfigId: modelId });
    await expect(resolveToolExecution(state.db, { operationType: "inpaint", toolKey: "image-edit", modelConfigId: secondModelId })).rejects.toMatchObject({ code: "TOOL_MODEL_CHANGED", status: 409 });
  });

  test("disabled binding, own/parent flags, model, provider, workflow and capabilities cannot fallback", async () => {
    const state = fixture();
    const input = { operationType: "inpaint", toolKey: "creative-local-restyle", modelConfigId: modelId };
    state.bind("creative-local-restyle", { enabled: false });
    await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "TOOL_DISABLED" });
    state.bind("creative-local-restyle");
    for (const flag of ["creative-local-restyle", "creative"]) {
      state.flags.set(flag, false);
      await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "MODULE_DISABLED" });
      state.flags.set(flag, true);
    }
    for (const field of ["enabled", "providerEnabled"] as const) {
      state.models[0]![field] = false;
      await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "MODEL_DISABLED" });
      state.models[0]![field] = true;
    }
    state.models[0]!.workflowConfigId = secondModelId; state.models[0]!.workflowEnabled = false;
    await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "WORKFLOW_DISABLED" });
    state.models[0]!.workflowEnabled = true; state.models[0]!.capabilities = ["chat"];
    await expect(resolveToolExecution(state.db, input)).rejects.toMatchObject({ code: "MODEL_CAPABILITY_MISMATCH" });
  });

  test("single task, batch and video preflight reject disabled source before queues/billing/upstream; chat sources are independent", async () => {
    const state = fixture(); state.bind("canvas-edit", { enabled: false }); state.bind("canvas-batch", { enabled: false }); state.bind("canvas-video", { enabled: false }); state.bind("canvas-chat", { enabled: false }); state.bind("gpt-chat");
    const { url } = await serve(state);
    const base = { requestId: "request-12345", projectId: "canvas", modelConfigId: modelId, prompt: "test" };
    for (const [path, payload] of [
      ["/tasks", { ...base, operationType: "inpaint", toolKey: "canvas-edit" }],
      ["/tasks/batch", { ...base, operationType: "batch_image", toolKey: "canvas-batch", items: [{ sourceUrls: ["source"] }] }],
      ["/tasks/preflight", { ...base, operationType: "video_generation", toolKey: "canvas-video" }],
      ["/chat/responses", { modelId, toolKey: "canvas-chat", input: [] }],
    ] as const) {
      const result = await post(`${url}${path}`, payload);
      expect(result.status).toBe(403);
      expect((await result.json()).error).toBe("TOOL_DISABLED");
    }
    expect(state.queues).toBe(0); expect(state.videoPreflights).toBe(0); expect(state.reservations).toHaveLength(0);
    // Independent chat reaches its credential check, never an external request.
    expect((await post(`${url}/chat/responses`, { toolKey: "gpt-chat", input: [] })).status).toBe(503);
    expect((await post(`${url}/chat/responses`, { toolKey: "gpt-chat", modelId: secondModelId, input: [] })).status).toBe(409);
  });

  test("a disabled parent API binding also blocks its child image operation", async () => {
    const state = fixture();
    state.bind("gpt-chat", { enabled: false });
    state.bind("gpt-chat-image");
    await expect(resolveToolExecution(state.db, { operationType: "image_generation", toolKey: "gpt-chat-image", modelConfigId: modelId })).rejects.toMatchObject({ code: "TOOL_DISABLED", status: 403 });
  });

  test("zero TOTAL overrides beat operation+model sums and disabled deployment never debits credits", async () => {
    const state = fixture();
    const zero = state.bind("image-edit", { creditCostOverride: 0, rmbCostOverride: 0, configurationVersion: 7 });
    const snapshot = await loadTaskPriceSnapshot(state.db, { operationType: "inpaint", modelConfigId: modelId, quantity: 2, toolConfiguration: zero });
    expect(snapshot).toMatchObject({ totalCredits: 0, totalRmb: 0, toolKey: "image-edit", configurationVersion: 7, operationCredits: 8, modelCredits: 4 });
    const positive = { ...zero, creditCostOverride: 50, rmbCostOverride: 2 };
    const reservation = await reserveCredits(state.db, { requestId: "reserve-test", userId: "user", operationType: "inpaint", modelConfigId: modelId, quantity: 2, toolConfiguration: positive, creditsEnabled: false });
    expect(reservation).toMatchObject({ credits: 0, rmbCost: 4, snapshot: { totalCredits: 0, creditCostOverride: 50 } });
    expect(state.statements.some(({ sql }) => /UPDATE (?:users|departments)|INSERT INTO credit_ledger/.test(sql))).toBe(false);
    expect(state.reservations[0]![6]).toMatchObject({ billingDisabled: true, toolKey: "image-edit", configurationVersion: 7 });
  });

  test("batch uses one binding and price snapshot, recording source on each task", async () => {
    const state = fixture(); state.bind("canvas-batch", { creditCostOverride: 10, rmbCostOverride: 0, configurationVersion: 2 });
    const { url } = await serve(state);
    const response = await post(`${url}/tasks/batch`, { requestId: "batch-123456", projectId: "canvas", toolKey: "canvas-batch", operationType: "batch_image", prompt: "edit", items: [{ sourceUrls: ["one"] }] });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.failures).toEqual([]); expect(result.tasks).toHaveLength(1);
    expect(result.tasks.every((task: { toolKey: string; credits: number; rmbCost: number }) => task.toolKey === "canvas-batch" && task.credits === 0 && task.rmbCost === 0)).toBe(true);
    expect(state.statements.filter(({ sql }) => sql.includes("FROM pricing_rule_versions"))).toHaveLength(1);
    expect(state.reservations.map(values => values[6])).toEqual([expect.objectContaining({ toolKey: "canvas-batch", configurationVersion: 2 })]);
  });

  test("prompt estimates honor known source binding and overrides instead of shared model/global price", async () => {
    const state = fixture(); state.bind("angle-control", { modelConfigId: secondModelId, creditCostOverride: 0, rmbCostOverride: 0 });
    const result = await resolveCurrentPromptPricing(state.db, { targetTool: "angle-control", historicalModelConfigId: modelId, parameters: { count: 3 } });
    expect(result).toMatchObject({ selectedModel: { id: secondModelId }, modelChanged: true, estimate: { toolKey: "angle-control", totalCredits: 0, totalRmb: 0 } });
  });
});
