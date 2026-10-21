import { expect, spyOn, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import type { Database } from "../src/db";
import { moduleKeys } from "../../shared/feature-catalog";
import { chatExecutionHeaders, createChatRouter } from "../src/routes/chat";
import * as providerTransport from "../src/provider-submission-transport";
import { encryptSecret } from "../src/security";

const modelId = "a1000000-0000-4000-8000-000000000001";
const otherId = "a1000000-0000-4000-8000-000000000002";
const image = "data:image/png;base64,AQID";
const events = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"knit plan"}}\n\ndata: {"type":"message_stop"}\n\n';

async function withPlanner(run: (state: {
  post: (body?: Record<string, unknown>) => Promise<Response>;
  calls: any[]; flags: Map<string, boolean>; binding: { modelConfigId: string | null; enabled: boolean };
  planner: { enabled: boolean }; models: Array<{ id: string; capabilities: string[] }>;
}) => Promise<void>) {
  const encryptionKey = Buffer.alloc(32, 7).toString("base64");
  const flags = new Map<string, boolean>(moduleKeys.map(key => [key, true]));
  const binding = { modelConfigId: modelId as string | null, enabled: true };
  const planner = { enabled: true };
  const models = [modelId, otherId].map(id => ({
    id, modelId: "claude-sonnet-5-5", enabled: true, providerEnabled: true, capabilities: ["chat", "vision"],
    model_id: "claude-sonnet-5-5", protocol: "apimart", base_url: "https://never-called.invalid/v1",
    encrypted_credentials: encryptSecret(JSON.stringify({ apiKey: "fixture-secret" }), encryptionKey),
  }));
  const db = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM module_flags")) return { rows: [{ enabled: flags.get(String(values[0])) }] };
    if (sql.includes("FROM tool_api_configurations")) {
      const toolKey = String(values[0]);
      return { rows: [{ toolKey, modelConfigId: toolKey === "gpt-chat" ? binding.modelConfigId : otherId,
        enabled: toolKey === "gpt-chat" ? binding.enabled : planner.enabled, configurationVersion: 1, creditCostOverride: 0, rmbCostOverride: 0 }] };
    }
    if (sql.includes("FROM model_configs")) return { rows: models.filter(model => model.id === values[0]) };
    if (sql.includes("INSERT INTO audit_logs")) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  } } as unknown as Database;
  const calls: any[] = [];
  const upstream = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    return body.stream ? new Response(events, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ content: [{ type: "text", text: '{"summary":"knit plan"}' }], stop_reason: "end_turn" });
  });
  const app = express(); app.use(express.json());
  app.use((request, _response, next) => { Object.assign(request, { auth: { id: "fixture-owner", role: "designer" } }); next(); });
  app.use("/chat", createChatRouter(db, { AUTH_ENABLED: "false", PROVIDER_ENCRYPTION_KEY: encryptionKey } as never));
  app.use(((error, _request, response, _next) => response.status(error.status ?? (error.name === "ZodError" ? 400 : 500)).json({ error: error.code ?? error.name })) as ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const post = (body: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${address.port}/chat/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "planner-fixture-request", toolKey: "creative-planner", modelId: "forged-client-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "分析毛衫" }, { type: "input_image", image_url: image }] }],
      tools: [], claude: { stream: false }, ...body }),
  });
  try { await run({ post, calls, flags, binding, planner, models }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); upstream.mockRestore(); }
}

test.each([false, true])("planner JSON/SSE exposes resolved UUID and request ID, preserving vision input (stream=%s)", async stream => {
  await withPlanner(async ({ post, calls, binding }) => {
    const response = await post({ claude: { stream }, modelId: otherId });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chat-model-config-id")).toBe(modelId);
    expect(response.headers.get("x-chat-request-id")).toBe("planner-fixture-request");
    expect(response.headers.get("content-type")).toContain(stream ? "text/event-stream" : "application/json");
    const body = await response.text(); expect(body).toContain("knit plan"); expect(body).not.toContain("fixture-secret");
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
    binding.modelConfigId = otherId;
    const changed = await post({ modelId });
    expect(changed.headers.get("x-chat-model-config-id")).toBe(otherId); await changed.text();
    expect(calls).toHaveLength(2);
  });
});

test("planner rejects images without vision before upstream, while text planning and ordinary chat remain available", async () => {
  await withPlanner(async ({ post, calls, models }) => {
    models[0]!.capabilities = ["chat"];
    const rejected = await post();
    expect(rejected.status).toBe(400); expect((await rejected.json()).error).toBe("MODEL_VISION_REQUIRED");
    expect(calls).toHaveLength(0);
    const textOnly = await post({ input: [{ role: "user", content: "设计一款毛衫" }] });
    expect(textOnly.status).toBe(200); await textOnly.text();
    const ordinary = await post({ toolKey: "gpt-chat" });
    expect(ordinary.status).toBe(200); await ordinary.text();
    expect(calls).toHaveLength(2);
  });
});

test("planner validates request IDs and respects own/parent switches and cleared shared models before upstream", async () => {
  await withPlanner(async ({ post, calls, binding, planner, flags }) => {
    const invalid = await post({ requestId: "unsafe\r\nheader" }); expect(invalid.status).toBe(400);
    expect(invalid.headers.get("x-chat-request-id")).toBeNull();
    planner.enabled = false; expect((await post()).status).toBe(403); planner.enabled = true;
    flags.set("creative", false); expect((await post()).status).toBe(403); flags.set("creative", true);
    binding.modelConfigId = null; expect((await post()).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

test("chat provenance never exposes a model alias or an invalid request ID", () => {
  expect(chatExecutionHeaders("private-model-name", "invalid\r\nheader")).toEqual({});
  expect(chatExecutionHeaders(modelId)).toEqual({ "x-chat-model-config-id": modelId });
});
