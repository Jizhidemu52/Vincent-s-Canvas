import { expect, spyOn, test } from "bun:test";

type DemoFetch = (request: Request) => Promise<Response>;
type DemoModel = { id: string; modelId: string; parameterModelId?: string; providerId: string; capabilities: string[]; creditCost: number; rmbCost: number };

test("open demo ignores legacy OpenToken selections and uses the shared Carbon default for chat and tool continuation", async () => {
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
  const toolCalls = [{ id: "read-1", type: "function", function: { name: "read_node", arguments: '{"id":"node-1"}' } }];
  const tools = [{ type: "function", name: "read_node", parameters: { type: "object", properties: { id: { type: "string" } } } }];
  globalThis.fetch = (async (url, init) => {
    const address = String(url);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    upstreamCalls.push({ url: address, headers: new Headers(init?.headers), body });
    if (address === "http://mark.test/v1/chat/completions") {
      const messages = body.messages as Array<{ role: string }>;
      return Response.json({ choices: [messages.at(-1)?.role === "tool"
        ? { message: { role: "assistant", content: "Tool result accepted." }, finish_reason: "stop" }
        : { message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }] });
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
    const catalog = await (await request("/api/models")).json();
    const visibleModels = catalog.models as DemoModel[];
    const gptModel = visibleModels.find((model) => model.modelId === "gpt-6-astra")!;
    const carbon = visibleModels.find(model => model.parameterModelId === "gemini-4-carbon")!;
    const claudeModel = { id: "40000000-0000-4000-8000-000000000125", modelId: "claude-fable-5-1" };
    expect(gptModel).toBeDefined();
    expect(carbon).toBeDefined();
    expect(carbon.capabilities).toEqual(["chat", "vision", "tools"]);
    expect(catalog.tools.find((tool: { toolKey: string }) => tool.toolKey === "gpt-chat").modelConfigId).toBe(carbon.id);
    expect(catalog.tools.find((tool: { toolKey: string }) => tool.toolKey === "canvas-chat").modelConfigId).toBe(carbon.id);
    expect(visibleModels.some((model) => model.modelId === claudeModel.modelId)).toBe(false);
    expect(JSON.stringify(visibleModels)).not.toContain("test-shared-key");
    expect(await (await chat(gptModel.id, { tools })).json()).toMatchObject({ toolCalls, stopReason: "tool_calls" });
    expect(upstreamCalls.at(-1)!.url).toBe("http://mark.test/v1/chat/completions");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer test-mark-key");
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "gemini-4-carbon", stream: false, messages: [{ role: "user", content: "hello" }] });

    const claudeResult = await (await chat(claudeModel.modelId, { tools, claude: { thinking: true } })).json();
    expect(claudeResult).toMatchObject({ toolCalls, stopReason: "tool_calls" });
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer test-mark-key");
    expect(upstreamCalls.at(-1)!.headers.get("anthropic-version")).toBeNull();
    expect(upstreamCalls.at(-1)!.body.thinking).toBeUndefined();
    const continued = await chat(claudeModel.id, {
      tools,
      claude: { stream: true, thinking: false, maxTokens: 4096 },
      input: [
        { type: "function_call", call_id: "read-1", name: "read_node", arguments: '{"id":"node-1"}' },
        { type: "function_call_output", call_id: "read-1", output: "node contents" },
      ],
    });
    expect(continued.headers.get("content-type")).toContain("application/json");
    expect(await continued.json()).toMatchObject({ content: "Tool result accepted.", toolCalls: [], stopReason: "stop" });
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "gemini-4-carbon", stream: false, messages: [
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: "read-1", content: "node contents" },
    ] });
    expect(upstreamCalls.at(-1)!.body.thinking).toBeUndefined();
    expect(upstreamCalls.at(-1)!.body.output_config).toBeUndefined();

    const callCount = upstreamCalls.length;
    expect((await chat("unknown-model")).status).toBe(200);
    expect(upstreamCalls).toHaveLength(callCount + 1);
    expect(upstreamCalls.every(call => call.body.model === "gemini-4-carbon" && call.url === "http://mark.test/v1/chat/completions" && call.body.stream === false)).toBe(true);
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
