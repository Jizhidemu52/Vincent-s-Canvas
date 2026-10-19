import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

type PublicModel = { id: string; modelId: string; parameterModelId?: string; capabilities: string[] };

test("demo defaults every chat entry to Sonnet Messages and SSE regardless of stale client model choices", async () => {
  const calls: Array<{ path: string; headers: Headers; body: any; raw: string }> = [];
  const assistantContent = [
    { type: "thinking", thinking: "", signature: "opaque-demo-signature" },
    { type: "tool_use", id: "read-1", name: "read_node", input: { id: "knit" } },
  ];
  const events = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Original knit preserved."}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const raw = await request.text();
    const body = JSON.parse(raw);
    calls.push({ path, headers: request.headers, body, raw });
    if (path === "/mark/v1/messages" && request.headers.get("authorization") === "Bearer isolated-mark-key") {
      return body.stream ? new Response(events, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ type: "message", role: "assistant", content: assistantContent, stop_reason: "tool_use" });
    }
    if (path === "/mark/v1/responses" && request.headers.get("authorization") === "Bearer isolated-mark-key") {
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "APIMart Astra reply." }] }], status: "completed" });
    }
    if (path === "/opentoken/v1/responses" && request.headers.get("authorization") === "Bearer isolated-opentoken-key") {
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "OpenToken Astra reply." }] }] });
    }
    return Response.json({ error: "Wrong provider, credentials, or endpoint" }, { status: 403 });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, "src/demo-server.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "ignore", stderr: "pipe",
    env: { ...process.env, DEMO_STATE_PATH: ":memory:", DEMO_RECOVERY_FILE: "", DEMO_PORT: String(port), DEMO_HOST: "127.0.0.1",
      OA_LOGIN_ENABLED: "false", AUTH_ENABLED: "true", CREDITS_ENABLED: "false", LOCAL_STANDALONE: "true", ROLE_PORTALS_ENABLED: "false", STANDALONE_WEB_DIR: "", DEMO_PUBLIC_ASSET_ORIGIN: "",
      OPENTOKEN_API_KEY: "isolated-opentoken-key", APIMART_API_KEY: "wrong-legacy-key", GPT_IMAGE_2_API_KEY: "",
      OPENTOKEN_BASE_URL: `http://127.0.0.1:${provider.port}/opentoken/v1`, APIMART_BASE_URL: `http://127.0.0.1:${provider.port}/legacy/v1`,
      MARK_IMAGE_BASE_URL: `http://127.0.0.1:${provider.port}/mark/v1`, MARK_IMAGE_API_KEY: "isolated-mark-key" },
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const chat = (modelId: string, extra: Record<string, unknown> = {}) => request("/api/chat/responses", {
    modelId, toolKey: "gpt-chat", input: [{ role: "user", content: "Inspect this knit. 中文🧶" }], tools: [], ...extra,
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`${base}/api/health`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    // BusinessConfig consumes this same public /api/models endpoint.
    const catalog = await request("/api/models").then(response => response.json());
    const models = catalog.models as PublicModel[];
    const chats = models.filter(model => model.capabilities.includes("chat"));
    expect(chats).toHaveLength(3);
    const sonnet = chats.find(model => model.parameterModelId === "claude-sonnet-5-5")!;
    const markAstra = chats.find(model => model.parameterModelId === "gpt-6-astra")!;
    const openTokenAstra = chats.find(model => model.modelId === "gpt-6-astra")!;
    expect(sonnet).toBeDefined(); expect(markAstra).toBeDefined(); expect(openTokenAstra).toBeDefined();
    expect(sonnet.modelId).toBe(sonnet.id);
    expect(catalog.tools.find((tool: any) => tool.toolKey === "gpt-chat").modelConfigId).toBe(sonnet.id);
    expect(catalog.tools.find((tool: any) => tool.toolKey === "canvas-chat").modelConfigId).toBe(sonnet.id);
    expect(JSON.stringify(catalog)).not.toMatch(/isolated-mark-key|isolated-opentoken-key|wrong-legacy-key|127\.0\.0\.1/);
    const tools = [{ type: "function", name: "read_node", parameters: { type: "object", properties: { id: { type: "string" } } } }];
    const response = await chat(sonnet.id, { tools, toolChoice: "required", claude: { maxTokens: 4096, thinking: true } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claudeAssistantContent: assistantContent, toolCalls: [{ id: "read-1", function: { name: "read_node", arguments: '{"id":"knit"}' } }], stopReason: "tool_use" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/mark/v1/messages");
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(calls[0]!.body).toEqual({ model: "claude-sonnet-5-5", max_tokens: 4096, messages: [{ role: "user", content: "Inspect this knit. 中文🧶" }], tools: [{ name: "read_node", input_schema: tools[0]!.parameters }], tool_choice: { type: "any" } });
    expect(calls[0]!.raw).toContain("中文🧶");
    const stream = await chat(sonnet.id, { claude: { stream: true, maxTokens: 100_000 }, input: [{ type: "claude_assistant", content: assistantContent }, { type: "function_call_output", call_id: "read-1", output: "Cable knit 中文🧶" }] });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toBe(events);
    expect(calls[1]!.body).toEqual({ model: "claude-sonnet-5-5", max_tokens: 16384, stream: true, messages: [{ role: "assistant", content: assistantContent }, { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "Cable knit 中文🧶" }] }] });
    expect(calls[1]!.raw).toContain("中文🧶");
    expect(await (await chat(markAstra.id)).json()).toMatchObject({ claudeAssistantContent: assistantContent });
    expect(await (await chat(openTokenAstra.id, { toolKey: "canvas-chat" })).json()).toMatchObject({ claudeAssistantContent: assistantContent });
    expect(await (await chat("forged-client-model", { toolKey: undefined })).json()).toMatchObject({ claudeAssistantContent: assistantContent });
    expect(calls.map(call => call.path)).toEqual(Array(5).fill("/mark/v1/messages"));
  } finally {
    child.kill(); await child.exited; provider.stop(true);
  }
}, 15_000);
