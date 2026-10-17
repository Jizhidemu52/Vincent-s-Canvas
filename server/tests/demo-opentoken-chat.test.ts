import { expect, spyOn, test } from "bun:test";

type DemoFetch = (request: Request) => Promise<Response>;
type DemoModel = { id: string; modelId: string; providerId: string; capabilities: string[]; creditCost: number; rmbCost: number };

test("open demo ignores legacy OpenToken selections and uses the shared Sonnet default for chat and streams", async () => {
  const testEnv = {
    LOCAL_STANDALONE: "true",
    OA_LOGIN_ENABLED: "false",
    OPENTOKEN_API_KEY: "test-shared-key",
    OPENTOKEN_BASE_URL: "http://opentoken.test/v1",
    APIMART_API_KEY: "test-apimart-key",
    GPT_IMAGE_2_API_KEY: "",
    APIMART_BASE_URL: "http://apimart.test/v1",
    MARK_IMAGE_BASE_URL: "http://mark.test/v1",
    MARK_IMAGE_API_KEY: "test-mark-key",
    DEMO_RECOVERY_FILE: "",
    DEMO_STATE_PATH: ":memory:",
    DEMO_PUBLIC_ASSET_ORIGIN: "",
    STANDALONE_WEB_DIR: "",
  };
  const savedEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  let demoFetch: DemoFetch | undefined;
  const serve = spyOn(Bun, "serve").mockImplementation((options) => {
    const handler = options as unknown as { fetch: DemoFetch; error: (error: Error) => Response };
    demoFetch = async request => { try { return await handler.fetch(request); } catch (error) { return handler.error(error as Error); } };
    return {} as never;
  });
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, "log").mockImplementation(() => {});
  const upstreamCalls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const assistantContent = [
    { type: "thinking", thinking: "inspect", signature: "mock-signature" },
    { type: "tool_use", id: "read-1", name: "read_node", input: { id: "node-1" } },
  ];
  const streamBody = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"stream reply"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  globalThis.fetch = (async (url, init) => {
    const address = String(url);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    upstreamCalls.push({ url: address, headers: new Headers(init?.headers), body });
    if (address === "http://mark.test/v1/messages") {
      return body.stream
        ? new Response(streamBody, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ content: assistantContent, stop_reason: "tool_use" });
    }
    throw new Error(`Unexpected upstream request: ${address}`);
  }) as typeof fetch;
  const request = async (path: string, method = "GET", body?: unknown) => {
    if (!demoFetch) throw new Error("Demo handler was not captured");
    return await demoFetch(new Request(`http://demo.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  };
  const chat = (modelId: string, options: Record<string, unknown> = {}) => request("/api/chat/responses", "POST", {
    modelId, input: [{ role: "user", content: "hello" }], tools: [], ...options,
  });
  try {
    await import("../src/demo-server");
    serve.mockRestore();
    expect((await request("/api/admin/model-configuration/providers")).status).toBe(403);
    expect((await request("/api/auth/login", "POST", { identifier: "admin", password: "Canvas2026!#", portal: "admin" })).status).toBe(404);
    const visibleModels = (await (await request("/api/models")).json()).models as DemoModel[];
    const gptModel = visibleModels.find((model) => model.modelId === "gpt-6-astra")!;
    const claudeModel = { id: "40000000-0000-4000-8000-000000000125", modelId: "claude-fable-5-1" };
    expect(gptModel).toBeDefined();
    expect(visibleModels.some((model) => model.modelId === claudeModel.modelId)).toBe(false);
    expect(JSON.stringify(visibleModels)).not.toContain("test-shared-key");
    expect(await (await chat(gptModel.id)).json()).toMatchObject({ claudeAssistantContent: assistantContent });
    expect(upstreamCalls.at(-1)!.url).toBe("http://mark.test/v1/messages");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer test-mark-key");
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hello" }] });

    const claudeResult = await (await chat(claudeModel.modelId, { claude: { thinking: true } })).json();
    expect(claudeResult).toMatchObject({ claudeAssistantContent: assistantContent, stopReason: "tool_use" });
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer test-mark-key");
    expect(upstreamCalls.at(-1)!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(upstreamCalls.at(-1)!.body.thinking).toBeUndefined();
    const streamed = await chat(claudeModel.id, {
      claude: { stream: true, thinking: false, maxTokens: 4096 },
      input: [
        { type: "claude_assistant", content: assistantContent },
        { type: "function_call_output", call_id: "read-1", output: "node contents" },
      ],
    });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toBe(streamBody);
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "claude-sonnet-5-5", stream: true, max_tokens: 4096, messages: [
      { role: "assistant", content: assistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "node contents" }] },
    ] });
    expect(upstreamCalls.at(-1)!.body.thinking).toBeUndefined();

    const callCount = upstreamCalls.length;
    expect((await chat("unknown-model")).status).toBe(200);
    expect(upstreamCalls).toHaveLength(callCount + 1);
    expect(upstreamCalls.every(call => call.body.model === "claude-sonnet-5-5" && call.url === "http://mark.test/v1/messages")).toBe(true);
  } finally {
    serve.mockRestore();
    log.mockRestore();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
