import { afterEach, expect, test } from "bun:test";
import { isClaudeMessagesModel, requestChatCompletion, requestClaudeStream } from "../src/routes/chat";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const model = { model_id: "claude-sonnet-5-5", protocol: "apimart", base_url: "http://apimart.test/v1/", encrypted_credentials: null };
const credentials = { apiKey: "isolated-apimart-key" };
const tools = [{ type: "function" as const, name: "read_node", description: "Read an existing canvas node", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }];
const blocks = [
  { type: "thinking", thinking: "", signature: "opaque-provider-signature" },
  { type: "text", text: "Inspecting the knit." },
  { type: "tool_use", id: "read-1", name: "read_node", input: { id: "knit" }, caller: { type: "direct" } },
];

test("only APIMart Sonnet 5.5 joins the existing native Claude route", () => {
  expect(isClaudeMessagesModel(model)).toBe(true);
  expect(isClaudeMessagesModel({ ...model, protocol: "anthropic" })).toBe(true);
  expect(isClaudeMessagesModel({ ...model, model_id: "gpt-6-astra" })).toBe(false);
  expect(isClaudeMessagesModel({ ...model, protocol: "openai-chat" })).toBe(false);
});

test.each(["http://apimart.test", "http://apimart.test/v1/"])("APIMart Sonnet uses documented Messages auth, multimodal input, tools, and native output at %s", async base_url => {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("http://apimart.test/v1/messages");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer isolated-apimart-key");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-sonnet-5-5", system: 'Keep the garment structure intact.\n\nFor this request, call only the tool "read_node".', max_tokens: 4096,
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }],
      tools: [{ name: tools[0]!.name, description: tools[0]!.description, input_schema: tools[0]!.parameters }],
      tool_choice: { type: "auto" },
    });
    return Response.json({ type: "message", role: "assistant", content: blocks, stop_reason: "tool_use", extra_provider_field: "ignored" });
  }) as typeof fetch;
  const result = await requestChatCompletion({ ...model, base_url }, credentials, {
    input: [
      { role: "system", content: "Keep the garment structure intact." },
      { role: "user", content: [{ type: "input_text", text: "Inspect this" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] },
    ], tools, toolChoice: { type: "function", name: "read_node" }, claude: { thinking: true, maxTokens: 4096 },
  });
  expect(result).toEqual({ content: "Inspecting the knit.", toolCalls: [{ id: "read-1", type: "function", function: { name: "read_node", arguments: '{"id":"knit"}' } }], claudeAssistantContent: blocks, stopReason: "tool_use" });
  expect(calls).toBe(1);
});

test("APIMart Sonnet streaming preserves native thinking signatures and tool results", async () => {
  const events = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    expect(String(url)).toBe("http://apimart.test/v1/messages");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "claude-sonnet-5-5", max_tokens: 8192, stream: true, output_config: { effort: "low" },
      messages: [{ role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "Cable knit" }] }],
      tools: [{ name: tools[0]!.name, description: tools[0]!.description, input_schema: tools[0]!.parameters }], tool_choice: { type: "auto" },
    });
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const result = await requestClaudeStream(model, credentials, {
    input: [{ type: "claude_assistant", content: blocks }, { type: "function_call_output", call_id: "read-1", output: "Cable knit" }], tools, claude: { thinking: false, maxTokens: 8192 },
  });
  expect(await result.text()).toBe(events);
  expect(calls).toBe(1);
});

for (const thinking of [undefined, false, true]) {
  test(`APIMart Sonnet preserves native Unicode and selects effort in both response modes (thinking=${thinking})`, async () => {
    const text = '中文针织 🧶🧵，引号 "，反斜杠 \\，字面转义 \\u4e2d，换行\n，行分隔\u2028，孤立代理\ud800';
    const schema = {
      type: "object", properties: { "材质": { type: "string", description: text, enum: ["棉质针织🧶", "棉麻"] } },
      required: ["材质"], additionalProperties: false,
    };
    const assistant = [
      { type: "thinking", thinking: "", signature: `opaque-signature:${text}` },
      { type: "redacted_thinking", data: `opaque-data:${text}` },
      { type: "tool_use", id: "inspect-1", name: "inspect_images", input: { "材质": "棉质针织🧶" } },
    ];
    const expected = structuredClone({
      model: "claude-sonnet-5-5", system: text, max_tokens: 2048,
      messages: [
        { role: "user", content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] },
        { role: "assistant", content: assistant },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "inspect-1", content: text }] },
      ],
      tools: [{ name: "inspect_images", description: text, input_schema: schema }], tool_choice: { type: "auto" },
      ...(thinking === false ? { output_config: { effort: "low" } } : {}),
    });
    const payloads: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("http://apimart.test/v1/messages");
      const encoded = String(init?.body);
      expect(encoded).toContain("中文针织 🧶🧵");
      const payload = JSON.parse(encoded);
      expect(encoded).toBe(JSON.stringify(payload));
      expect(payload).not.toHaveProperty("thinking");
      if (thinking === false) expect(payload.output_config).toEqual({ effort: "low" });
      else expect(payload).not.toHaveProperty("output_config");
      payloads.push(payload);
      expect(payload).toEqual({ ...expected, ...(payload.stream ? { stream: true } : {}) });
      if (payload.stream) return new Response('data: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } });
      return Response.json({ type: "message", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
    }) as typeof fetch;
    const input = {
      input: [
        { role: "system" as const, content: text },
        { role: "user" as const, content: [{ type: "input_text" as const, text }, { type: "input_image" as const, image_url: "data:image/png;base64,AQID" }] },
        { type: "claude_assistant" as const, content: assistant },
        { type: "function_call_output" as const, call_id: "inspect-1", output: text },
      ],
      tools: [{ type: "function" as const, name: "inspect_images", description: text, parameters: schema }],
      claude: { thinking },
    };
    expect((await requestChatCompletion(model, credentials, input)).content).toBe("OK");
    expect(await (await requestClaudeStream(model, credentials, input)).text()).toContain("message_stop");
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("stream");
    expect(payloads[1]).toEqual({ ...payloads[0], stream: true });
  });
}

test.each([false, true])("native Anthropic Sonnet preserves Unicode and selects low effort without disabling thinking (stream=%s)", async stream => {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const encoded = String(init?.body);
    expect(encoded).toContain("中文🧶");
    const payload = JSON.parse(encoded);
    expect(payload).not.toHaveProperty("thinking");
    expect(payload.output_config).toEqual({ effort: "low" });
    if (stream) return new Response('data: {"type":"message_stop"}\n\n');
    return Response.json({ content: [{ type: "text", text: "OK" }] });
  }) as typeof fetch;
  const request = stream ? requestClaudeStream : requestChatCompletion;
  await request({ ...model, protocol: "anthropic" }, credentials, { input: [{ role: "user", content: "中文🧶" }], tools: [], claude: { thinking: false } });
  expect(calls).toBe(1);
});

test.each([
  { protocol: "anthropic", model_id: "claude-sonnet-5", thinking: { type: "disabled" } },
  { protocol: "openai-chat", model_id: "claude-sonnet-5-5", thinking: undefined },
  { protocol: "apimart", model_id: "gpt-6-astra", thinking: undefined },
  { protocol: "apimart", model_id: "gpt-6-sol", thinking: undefined },
])("other models and provider protocols keep their existing request encoding: %j", async target => {
  globalThis.fetch = (async (_url, init) => {
    expect(String(init?.body)).toContain("中文🧶");
    const payload = JSON.parse(String(init?.body));
    expect(payload.thinking).toEqual(target.thinking);
    expect(payload).not.toHaveProperty("output_config");
    return target.protocol === "anthropic"
      ? Response.json({ content: [{ type: "text", text: "OK" }] })
      : Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  expect((await requestChatCompletion({ ...model, ...target }, credentials, { input: [{ role: "user", content: "中文🧶" }], tools: [], claude: { thinking: false } })).content).toBe("OK");
});

test.each([false, true])("APIMart Sonnet errors never leak credentials or replay submission (stream=%s)", async stream => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: { type: "apimart_error", message: `Authorization: Bearer ${credentials.apiKey}` } }, { status: 401 }); }) as unknown as typeof fetch;
  const request = stream ? requestClaudeStream : requestChatCompletion;
  const error = await request(model, credentials, { input: [{ role: "user", content: "Hello" }], tools: [] }).catch(error => error);
  expect(error).toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
  expect(error.message).toContain("401");
  expect(error.message).not.toContain(credentials.apiKey);
  expect(calls).toBe(1);
});

test("APIMart Sonnet rejects a Responses-native history before any provider submission", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("No provider request expected"); }) as unknown as typeof fetch;
  await expect(requestChatCompletion(model, credentials, { input: [{ type: "responses_assistant", output: [] }], tools: [] })).rejects.toMatchObject({ code: "CHAT_HISTORY_PROTOCOL_MISMATCH" });
  expect(calls).toBe(0);
});
