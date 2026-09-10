import { expect, spyOn, test } from "bun:test";
import { demoAccounts } from "../src/demo-accounts";

type DemoFetch = (request: Request) => Promise<Response>;
type DemoProvider = { id: string; name: string; protocol: string; hasCredentials: boolean };
type DemoModel = { id: string; modelId: string; providerId: string; capabilities: string[]; creditCost: number; rmbCost: number };

test("demo OpenToken supports shared and independently configured chat providers without network or a listening port", async () => {
  const testEnv = {
    LOCAL_STANDALONE: "true",
    OPENTOKEN_API_KEY: "",
    OPENTOKEN_BASE_URL: "http://opentoken.test/v1",
    APIMART_API_KEY: "test-apimart-key",
    GPT_IMAGE_2_API_KEY: "",
    APIMART_BASE_URL: "http://apimart.test/v1",
    DEMO_RECOVERY_FILE: "",
    DEMO_PUBLIC_ASSET_ORIGIN: "",
    STANDALONE_WEB_DIR: "",
  };
  const savedEnv = Object.fromEntries(Object.keys(testEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, testEnv);
  let demoFetch: DemoFetch | undefined;
  const serve = spyOn(Bun, "serve").mockImplementation((options) => {
    demoFetch = (options as { fetch: DemoFetch }).fetch;
    return {} as never;
  });
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, "log").mockImplementation(() => {});
  let cookie = "";
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
    if (address === "http://opentoken.test/v1/responses") {
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "gpt reply" }] }] });
    }
    if (address === "http://opentoken.test/v1/chat/completions") {
      return Response.json({ choices: [{ message: { content: "chat completions reply" }, finish_reason: "stop" }] });
    }
    if (address === "http://opentoken.test/v1/messages") {
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
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  };
  const providers = async () => (await (await request("/api/admin/model-configuration/providers")).json()).providers as DemoProvider[];
  const models = async () => (await (await request("/api/admin/model-configuration/models")).json()).models as DemoModel[];
  const chat = (modelId: string, options: Record<string, unknown> = {}) => request("/api/chat/responses", "POST", {
    modelId, input: [{ role: "user", content: "hello" }], tools: [], ...options,
  });
  try {
    await import("../src/demo-server");
    serve.mockRestore();
    const admin = demoAccounts.find((account) => account.portal === "admin")!;
    const login = await request("/api/auth/login", "POST", { identifier: admin.identifier, password: admin.password, portal: admin.portal });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const initialProviders = await providers();
    const initialModels = await models();
    const openToken = initialProviders.find((provider) => provider.name === "OpenToken")!;
    const claude = initialProviders.find((provider) => provider.name === "OpenToken Claude")!;
    const gptModel = initialModels.find((model) => model.modelId === "gpt-6-astra")!;
    const claudeModel = initialModels.find((model) => model.modelId === "claude-fable-5-1")!;
    expect(openToken).toMatchObject({ protocol: "openai", hasCredentials: false });
    expect(claude).toMatchObject({ protocol: "anthropic", hasCredentials: false });
    expect(gptModel).toMatchObject({ providerId: openToken.id, capabilities: ["chat", "vision", "tools"] });
    expect(claudeModel).toMatchObject({ providerId: claude.id, capabilities: ["chat", "vision", "tools"] });
    const hiddenModels = (await (await request("/api/models")).json()).models as DemoModel[];
    expect(hiddenModels.some((model) => [gptModel.id, claudeModel.id].includes(model.id))).toBe(false);
    expect((await chat(gptModel.id)).status).toBe(503);
    expect((await chat(claudeModel.modelId)).status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);

    await request(`/api/admin/model-configuration/providers/${claude.id}`, "PATCH", { credentials: { apiKey: "shared-from-claude" } });
    const configuredProviders = await providers();
    expect(configuredProviders.filter((provider) => [openToken.id, claude.id].includes(provider.id)).map((provider) => provider.hasCredentials)).toEqual([true, true]);
    expect(JSON.stringify(configuredProviders)).not.toContain("shared-from-claude");
    const visibleModels = (await (await request("/api/models")).json()).models as DemoModel[];
    for (const modelId of ["gpt-6-astra", "claude-fable-5-1", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
      expect(visibleModels.some((model) => model.modelId === modelId)).toBe(true);
    }
    expect(await (await chat(gptModel.id)).json()).toEqual({ content: "gpt reply", toolCalls: [] });
    expect(upstreamCalls.at(-1)!.url).toBe("http://opentoken.test/v1/responses");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer shared-from-claude");
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "gpt-6-astra", input: [{ role: "user", content: "hello" }] });

    await request(`/api/admin/model-configuration/providers/${openToken.id}`, "PATCH", { credentials: { apiKey: "shared-from-main" } });
    await request(`/api/admin/model-configuration/providers/${claude.id}`, "PATCH", { baseUrl: "http://opentoken.test", credentials: { apiKey: " " } });
    const claudeResult = await (await chat(claudeModel.modelId, { claude: { thinking: true } })).json();
    expect(claudeResult).toMatchObject({ claudeAssistantContent: assistantContent, stopReason: "tool_use" });
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer shared-from-main");
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
    expect(upstreamCalls.at(-1)!.body).toMatchObject({ model: "claude-fable-5-1", stream: true, max_tokens: 4096, messages: [
      { role: "assistant", content: assistantContent },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "node contents" }] },
    ] });
    expect(upstreamCalls.at(-1)!.body.thinking).toBeUndefined();

    const createProvider = async (name: string, protocol: string, apiKey?: string) => {
      const response = await request("/api/admin/model-configuration/providers", "POST", {
        name, protocol, baseUrl: "http://opentoken.test/v1", enabled: true,
        ...(apiKey === undefined ? {} : { credentials: { apiKey } }),
      });
      expect(response.status).toBe(201);
      return (await response.json()).provider as DemoProvider;
    };
    const privateChat = await createProvider("Independent OpenToken Chat", "openai-chat", "private-chat-key");
    await request(`/api/admin/model-configuration/models/${gptModel.id}`, "PATCH", { providerId: privateChat.id });
    const privateChatResult = await chat(gptModel.id);
    expect(privateChatResult.status).toBe(200);
    expect(await privateChatResult.json()).toMatchObject({ content: "chat completions reply", toolCalls: [] });
    expect(upstreamCalls.at(-1)!.url).toBe("http://opentoken.test/v1/chat/completions");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer private-chat-key");
    await request(`/api/admin/model-configuration/providers/${privateChat.id}`, "PATCH", { credentials: { apiKey: "updated-private-chat-key" } });
    await request(`/api/admin/model-configuration/providers/${privateChat.id}`, "PATCH", { credentials: { apiKey: " " } });
    expect((await chat(gptModel.modelId)).status).toBe(200);
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer updated-private-chat-key");

    const privateClaude = await createProvider("Independent OpenToken Claude", "anthropic", "private-claude-key");
    await request(`/api/admin/model-configuration/models/${claudeModel.id}`, "PATCH", { providerId: privateClaude.id });
    const privateClaudeResult = await chat(claudeModel.id, { claude: { stream: true } });
    expect(privateClaudeResult.status).toBe(200);
    expect(await privateClaudeResult.text()).toBe(streamBody);
    expect(upstreamCalls.at(-1)!.url).toBe("http://opentoken.test/v1/messages");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer private-claude-key");
    const privateProviderList = await providers();
    expect(JSON.stringify(privateProviderList)).not.toContain("private-chat-key");
    expect(JSON.stringify(privateProviderList)).not.toContain("private-claude-key");
    expect(privateProviderList.find((provider) => provider.id === openToken.id)!.protocol).toBe("openai");

    const validPrivateCallCount = upstreamCalls.length;
    await request(`/api/admin/model-configuration/providers/${privateChat.id}`, "PATCH", { enabled: false });
    expect((await chat(gptModel.id)).status).toBe(400);
    const noKeyProvider = await createProvider("Unconfigured Chat", "openai-chat", " ");
    expect(noKeyProvider.hasCredentials).toBe(false);
    await request(`/api/admin/model-configuration/models/${gptModel.id}`, "PATCH", { providerId: noKeyProvider.id });
    expect((await chat(gptModel.id)).status).toBe(503);
    await request(`/api/admin/model-configuration/models/${gptModel.id}`, "PATCH", { providerId: privateClaude.id });
    expect((await chat(gptModel.id)).status).toBe(400);
    await request(`/api/admin/model-configuration/models/${claudeModel.id}`, "PATCH", { providerId: openToken.id });
    expect((await chat(claudeModel.id)).status).toBe(400);
    expect(upstreamCalls).toHaveLength(validPrivateCallCount);

    await request(`/api/admin/model-configuration/models/${gptModel.id}`, "PATCH", { providerId: openToken.id });
    await request(`/api/admin/model-configuration/models/${claudeModel.id}`, "PATCH", { providerId: claude.id });
    expect((await chat(gptModel.id)).status).toBe(200);
    expect(upstreamCalls.at(-1)!.url).toBe("http://opentoken.test/v1/responses");
    expect(upstreamCalls.at(-1)!.headers.get("authorization")).toBe("Bearer shared-from-main");
    const completedCallCount = upstreamCalls.length;
    await request(`/api/admin/model-configuration/providers/${claude.id}`, "PATCH", { enabled: false });
    expect((await chat(claudeModel.id)).status).toBe(400);
    await request(`/api/admin/model-configuration/models/${gptModel.id}`, "PATCH", { enabled: false });
    expect((await chat(gptModel.modelId)).status).toBe(400);
    expect((await chat("unknown-model")).status).toBe(400);
    expect(upstreamCalls).toHaveLength(completedCallCount);
    const unchangedModels = (await models()).filter((model) => ![openToken.id, claude.id].includes(model.providerId));
    expect(unchangedModels).toEqual(initialModels.filter((model) => ![openToken.id, claude.id].includes(model.providerId)));
    expect((await providers()).filter((provider) => initialProviders.some((initial) => initial.id === provider.id) && ![openToken.id, claude.id].includes(provider.id))).toEqual(initialProviders.filter((provider) => ![openToken.id, claude.id].includes(provider.id)));
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
