import { afterEach, expect, test } from "bun:test";
import { requestChatCompletion, requestClaudeStream } from "../src/routes/chat";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Chat Completions preserves GPT 6, vision, tools and ordered tool results", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("http://gw.opentoken.io/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-shared-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-6-astra",
      messages: [
        { role: "system", content: "Inspect the canvas." },
        { role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }] },
        { role: "assistant", content: null, tool_calls: [
          { id: "first", type: "function", function: { name: "read_node", arguments: '{"id":"one"}' } },
          { id: "second", type: "function", function: { name: "read_node", arguments: '{"id":"two"}' } },
        ] },
        { role: "tool", tool_call_id: "first", content: "red" },
        { role: "tool", tool_call_id: "second", content: "blue" },
      ],
      tools: [{ type: "function", function: { name: "read_node", description: "Read a node", parameters: { type: "object", properties: { id: { type: "string" } } } } }],
      tool_choice: { type: "function", function: { name: "read_node" } },
      parallel_tool_calls: false,
    });
    return Response.json({ choices: [{ message: { content: "Read another node.", tool_calls: [{ id: "third", type: "function", function: { name: "read_node", arguments: '{"id":"three"}' } }] }, finish_reason: "tool_calls" }] });
  }) as typeof fetch;
  const result = await requestChatCompletion(
    { model_id: "gpt-6-astra", protocol: "openai-chat", base_url: "http://gw.opentoken.io/v1/", encrypted_credentials: null },
    { apiKey: "test-shared-key" },
    { input: [
      { role: "system", content: "Inspect the canvas." },
      { role: "user", content: [{ type: "input_text", text: "Describe this" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] },
      { type: "function_call", call_id: "first", name: "read_node", arguments: '{"id":"one"}' },
      { type: "function_call", call_id: "second", name: "read_node", arguments: '{"id":"two"}' },
      { type: "function_call_output", call_id: "first", output: "red" },
      { type: "function_call_output", call_id: "second", output: "blue" },
    ], tools: [{ type: "function", name: "read_node", description: "Read a node", parameters: { type: "object", properties: { id: { type: "string" } } } }], toolChoice: { type: "function", name: "read_node" } },
  );
  expect(result).toMatchObject({ content: "Read another node.", toolCalls: [{ id: "third", type: "function", function: { name: "read_node", arguments: '{"id":"three"}' } }], stopReason: "tool_calls" });
});

test("the existing OpenAI provider continues using Responses for GPT 6", async () => {
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("http://gw.opentoken.io/v1/responses");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-6-astra", input: [{ role: "user", content: "hello" }], tools: [] });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "hello back" }] }] });
  }) as typeof fetch;
  expect(await requestChatCompletion({ model_id: "gpt-6-astra", protocol: "openai", base_url: "http://gw.opentoken.io/v1", encrypted_credentials: null }, { apiKey: "test" }, { input: [{ role: "user", content: "hello" }], tools: [] })).toEqual({ content: "hello back", toolCalls: [] });
});

for (const baseUrl of ["http://gw.opentoken.io", "http://gw.opentoken.io/v1/"]) {
  for (const stream of [false, true]) {
    test(`OpenToken Claude uses Bearer and a single /v1 with ${baseUrl}, stream=${stream}`, async () => {
      globalThis.fetch = (async (url, init) => {
        expect(String(url)).toBe("http://gw.opentoken.io/v1/messages");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-shared-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ model: "claude-fable-5-1", max_tokens: 4096, messages: [{ role: "user", content: "hello" }] });
        expect(body).not.toHaveProperty("thinking");
        expect(body.stream).toBe(stream ? true : undefined);
        return stream ? new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } }) : Response.json({ content: [{ type: "text", text: "hello back" }] });
      }) as typeof fetch;
      const model = { model_id: "claude-fable-5-1", protocol: "anthropic", base_url: baseUrl, encrypted_credentials: null };
      const input = { input: [{ role: "user" as const, content: "hello" }], tools: [], claude: { stream, thinking: true, maxTokens: 4096 } };
      if (stream) expect(await (await requestClaudeStream(model, { apiKey: "test-shared-key" }, input)).text()).toContain("message_stop");
      else expect(await requestChatCompletion(model, { apiKey: "test-shared-key" }, input)).toEqual({ content: "hello back", toolCalls: [] });
    });
  }
}
