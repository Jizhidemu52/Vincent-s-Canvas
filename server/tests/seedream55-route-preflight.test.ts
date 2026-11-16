import { afterEach, describe, expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import type { Cache, Database } from "../src/db";
import type { PromptCompiler } from "../src/prompt-compiler";
import { createTasksRouter } from "../src/routes/tasks";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
async function fixture() {
  let compilations = 0;
  const modelId = "11111111-1111-4111-8111-111111111111";
  const statements: string[] = [];
  const db = { query: async (sql: string) => {
    statements.push(sql);
    if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error("Preview cannot mutate task or billing state");
    if (sql.includes("FROM module_flags")) return { rows: [{ enabled: true }] };
    if (sql.includes("FROM tool_api_configurations")) return { rows: [] };
    if (sql.includes("FROM model_configs")) return { rows: [{ id: modelId, modelId: "seedream-5-5", protocol: "apimart", enabled: true, providerEnabled: true, workflowConfigId: null, capabilities: ["generate", "edit"] }] };
    if (sql.includes("count(*)::int AS count FROM tasks")) return { rows: [{ count: 0 }] };
    return { rows: [] };
  } } as unknown as Database;
  const compiler = { compile: async () => { compilations++; return { id: "22222222-2222-4222-8222-222222222222", status: "success", prompt: "A plain knitted scarf", optimized: true }; } } as unknown as PromptCompiler;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: "33333333-3333-4333-8333-333333333333", role: "designer", departmentId: null } }); next(); });
  app.use("/tasks", createTasksRouter(db, {} as Cache, false, undefined, { promptCompiler: compiler }));
  app.use(((error, _request, response, _next) => response.status(error.status ?? 400).json({ code: error.code ?? "FIXTURE_ERROR", message: error.message })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(done => server.once("listening", done));
  const body = { requestId: "doubao-preview-fixture", projectId: "fixture", operationType: "image_generation", modelConfigId: modelId, toolKey: "image", prompt: "围巾",
    promptInput: { scene: "free-optimize", mode: "generate", userText: "围巾", fields: {}, referenceRoles: [], hasMask: false },
    parameters: { size: "auto", resolution: "1k", n: 1 }, sourceUrls: [], priority: "normal" };
  const request = (overrides: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/tasks/preview`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...overrides }),
  });
  return { body, request, statements, compilations: () => compilations };
}

describe("Doubao preview validates before prompt compilation", () => {
  test.each([
    { resolution: "4k" }, { n: 2 }, { count: 2 }, { layer_decomposition: true },
    { inputArchive: { maskReferenceIndex: 1 } }, { inputArchive: { markupReferenceIndex: 1 } },
    { background: "transparent", output_format: "jpeg" },
  ])("unsupported %j never invokes optimizer", async parameters => {
    const f = await fixture();
    const response = await f.request({ parameters: { ...f.body.parameters, ...parameters } });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_IMAGE_PARAMETERS");
    expect(f.compilations()).toBe(0);
  });
  test("prompt masks and unowned references cannot reach optimizer", async () => {
    const f = await fixture();
    const masked = await f.request({ promptInput: { ...f.body.promptInput, hasMask: true } });
    expect(masked.status).toBe(400); expect(f.compilations()).toBe(0);
    const unauthorized = await f.request({ sourceUrls: ["/api/assets/44444444-4444-4444-8444-444444444444/content"] });
    expect(unauthorized.status).toBe(400);
    expect((await unauthorized.json()).code).toBe("INVALID_SOURCE");
    expect(f.compilations()).toBe(0);
  });
  test("ordinary adaptive settings compile once and preserve negative requirements without submitting an image", async () => {
    const f = await fixture();
    const response = await f.request({ parameters: { ...f.body.parameters, negative_prompt: "不要文字" } });
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview.preview.prompt).toContain("A plain knitted scarf");
    expect(preview.preview.prompt).toContain("不要文字");
    expect(f.compilations()).toBe(1);
    expect(f.statements.some(sql => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
  });
});
