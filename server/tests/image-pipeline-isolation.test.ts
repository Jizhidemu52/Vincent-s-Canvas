import { afterEach, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import type { Database } from "../src/db";
import { createTasksRouter } from "../src/routes/tasks";
import { preflightStoredVideoTask } from "../src/stored-video-preflight";

const modelConfigId = "61000000-0000-4000-8000-000000000001";
const otherModelConfigId = "61000000-0000-4000-8000-000000000002";
const ownerId = "62000000-0000-4000-8000-000000000001";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function fixture(modelId = "gemini-nano-banana-2.1", boundModelId: string | null = null) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const model = {
    id: modelConfigId, modelId, model_id: modelId, provider_id: "pipeline-fixture-provider",
    protocol: "apimart", enabled: true, providerEnabled: true, workflowConfigId: null,
    capabilities: ["generate", "edit", "video"], credit_cost: 0, rmb_cost: "0",
  };
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
      if (sql.includes("FROM tool_api_configurations")) return { rows: [{
        toolKey: values[0], modelConfigId: boundModelId, enabled: true, allowRawPrompt: true,
        creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1,
      }] };
      if (sql.includes("FROM layer_studio_prices")) return { rows: [{ inputRmb: 0.01, lowOutputRmb: 0.1, highOutputRmb: 0.2, version: 1 }] };
      if (sql.includes("FROM model_configs")) return { rows: [model] };
      if (sql.includes("AS count,") && sql.includes("AS paused FROM tasks")) return { rows: [{ count: 0, paused: 0 }] };
      if (sql.includes("FROM tasks") || sql.includes("FROM credit_reservations")) return { rows: [] };
      if (sql.includes("FROM pricing_rule_versions")) return { rows: [{ credits: 0, rmb_cost: "0", version: 1 }] };
      if (sql.includes("FROM users")) return { rows: [{ department_id: null }] };
      if (sql.startsWith("INSERT INTO tasks")) return { rows: [{ id: values[0], queuedAt: new Date().toISOString(), availableAt: new Date().toISOString() }] };
      if (sql.startsWith("UPDATE tasks") || sql.startsWith("INSERT INTO credit_reservations")) return { rows: [] };
      throw new Error(`Unexpected fixture SQL: ${sql}`);
    },
    release() {},
  };
  const db = { ...client, connect: async () => client } as unknown as Database;
  let queued = 0;
  let preflights = 0;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: ownerId, role: "designer", departmentId: null } }); next(); });
  app.use("/tasks", createTasksRouter(db, { eval: async () => ++queued } as never, false, async (database, input) => {
    preflights++;
    return preflightStoredVideoTask(database, input);
  }));
  app.use(((error, _request, response, _next) => {
    response.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: error.code, message: error.message });
  }) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const post = (body: Record<string, unknown>, path = "") => fetch(`http://127.0.0.1:${address.port}/tasks${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { post, statements, queued: () => queued, preflights: () => preflights };
}

const input = (parameters: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  requestId: "pipeline-fixture-request", projectId: "pipeline-fixture-canvas", operationType: "image_generation",
  toolKey: "image", modelConfigId, prompt: "保持针织结构，改为蓝色", parameters, sourceUrls: [], ...overrides,
});

describe("explicit image pipelines are isolated from ordinary task admission", () => {
  test.each(["", "FAST", "unknown", "toString", "__proto__", null, false, 1, {}, []].map(pipeline => [pipeline]))("rejects invalid own pipeline %j before any database or queue work", async pipeline => {
    const f = await fixture();
    const response = await f.post(input({ pipeline, resolution: "2k" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_IMAGE_PIPELINE");
    expect(f.statements).toEqual([]);
    expect(f.queued()).toBe(0);
    expect(f.preflights()).toBe(0);
  });

  test.each(["fast", "refined", "refined_ultra"])("rejects recognized %s without inventing a model binding", async pipeline => {
    const f = await fixture();
    for (const operationType of ["image_generation", "inpaint", "batch_image", "upscale", "seamless_stitch"]) {
      const response = await f.post(input({ pipeline }, { operationType }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("IMAGE_PIPELINE_NOT_CONFIGURED");
    }
    expect(f.statements).toEqual([]);
    expect(f.queued()).toBe(0);
  });

  test("rejects pipeline before quick-action or layer early returns, preview compilation and batch pricing", async () => {
    const f = await fixture();
    const requests = [
      { path: "", body: input({ pipeline: "fast", quickImageAction: "change-color" }, { operationType: "inpaint", toolKey: "garment-colorway" }) },
      { path: "", body: input({ pipeline: "refined" }, { toolKey: "layer-studio" }) },
      { path: "/preview", body: input({ pipeline: "fast" }, { promptInput: { scene: "free-optimize", mode: "generate", userText: "蓝色围巾", fields: {}, referenceRoles: [], hasMask: false } }) },
      { path: "/batch", body: input({ pipeline: "fast" }, { operationType: "batch_image", toolKey: "canvas-batch", items: [{ sourceUrls: ["/fixture-source"] }] }) },
    ];
    for (const { body, path } of requests) {
      const response = await f.post(body, path);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("IMAGE_PIPELINE_NOT_CONFIGURED");
    }
    expect(f.statements.every(({ sql }) => sql.startsWith("SELECT t.id") && sql.includes("WHERE t.request_id=$1 AND t.user_id=$2"))).toBe(true);
    expect(f.queued()).toBe(0);
  });

  test("rejects image pipelines for non-image admission and video preflight before resolving models", async () => {
    const f = await fixture("seedance-2-5-flash");
    for (const operationType of ["video_generation", "audio_generation", "chat", "workflow"]) {
      const response = await f.post(input({ pipeline: "fast" }, { operationType }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("IMAGE_PIPELINE_OPERATION_UNSUPPORTED");
    }
    for (const [pipeline, error] of [["fast", "IMAGE_PIPELINE_OPERATION_UNSUPPORTED"], ["unknown", "INVALID_IMAGE_PIPELINE"]]) {
      const response = await f.post(input({ pipeline }, { operationType: "video_generation", toolKey: "video" }), "/preflight");
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(error);
    }
    expect(f.statements).toEqual([]);
    expect(f.preflights()).toBe(0);
    expect(f.queued()).toBe(0);
  });

  test.each(["gemini-nano-banana-2.1", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "seedream-5-5"])("preserves selected %s, 2k settings and original prompt without pipeline", async modelId => {
    const f = await fixture(modelId);
    const parameters = { size: "3:4", resolution: "2k", n: 1, count: 1 };
    const body = input(parameters);
    const response = await f.post(body);
    const result = await response.json();
    expect(result).toMatchObject({ task: { modelConfigId, prompt: body.prompt, parameters, optimized: false } });
    expect(response.status).toBe(201);
    expect(result.task).not.toHaveProperty("modelId");
    const persisted = f.statements.find(({ sql }) => sql.startsWith("UPDATE tasks SET model_config_id="));
    expect(persisted?.values.slice(0, 3)).toEqual([modelConfigId, "image", { ...parameters, tool: "image" }]);
    expect(f.queued()).toBe(1);
    expect(f.preflights()).toBe(0);
  });

  test("keeps an administrator's ordinary image binding authoritative", async () => {
    const f = await fixture("gpt-image-2.6-sunburst", modelConfigId);
    const response = await f.post(input({ resolution: "2k" }, { modelConfigId: otherModelConfigId }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("TOOL_MODEL_CHANGED");
    expect(f.queued()).toBe(0);
    expect(f.statements.some(({ sql }) => sql.startsWith("INSERT INTO tasks"))).toBe(false);
  });

  test("preserves ordinary video parameters and its original model through preflight and admission", async () => {
    const f = await fixture("seedance-2-5-flash", modelConfigId);
    const parameters = { seconds: 6, resolution: "720p", size: "16:9", generateAudio: false };
    const body = input(parameters, { operationType: "video_generation", toolKey: "video" });
    const preflight = await f.post(body, "/preflight");
    expect(preflight.status).toBe(200);
    expect(f.queued()).toBe(0);
    const response = await f.post(body);
    expect(response.status).toBe(201);
    expect((await response.json()).task).toMatchObject({ modelConfigId, parameters });
    expect(f.queued()).toBe(1);
    expect(f.preflights()).toBe(2);
    const persisted = f.statements.find(({ sql }) => sql.startsWith("UPDATE tasks SET model_config_id="));
    expect(persisted?.values.slice(0, 3)).toEqual([modelConfigId, "video", {
      ...parameters, tool: "video", referenceCount: 0, upstreamBillingSeconds: 6, videoMode: "text",
    }]);
  });
});
