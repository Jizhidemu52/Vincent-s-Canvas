import { afterEach, expect, test } from "bun:test";

import { requestChatCompletion } from "../src/routes/chat";
import { readProviderSubmissionDiagnostics } from "../src/provider-submission-transport";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const model = { model_id: "gpt-6-astra", protocol: "apimart", base_url: "http://mark-provider.invalid/v1/", encrypted_credentials: null };
const credentials = { apiKey: "offline-test-key" };
const plainInput = { input: [{ role: "user" as const, content: "Describe a cable-knit cardigan." }], tools: [] };
const completion = { choices: [{ message: { content: "A textured cable-knit cardigan with ribbed trims." }, finish_reason: "stop" }] };
const nativeCompletion = { status: "completed", output: [{ id: "msg-one", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: completion.choices[0]!.message.content, annotations: [] }] }] };

test.each(["gpt-6-astra", "gpt-6-sol"])("Mark HTTP errors never echo provider credentials or replay either chat endpoint: %s", async (modelId) => {
    let calls = 0;
    globalThis.fetch = (async (_url, _init) => {
        calls++;
        return Response.json({ error: { message: `Authorization: Bearer ${credentials.apiKey}; private upstream detail` } }, { status: 401 });
    }) as typeof fetch;
    const error = await requestChatCompletion({ ...model, model_id: modelId }, credentials, plainInput).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain(credentials.apiKey);
    expect(error.message).not.toContain("private upstream detail");
    expect(calls).toBe(1);
});

test.each([false, true])("Mark GPT6 uses one fixed non-streaming Responses request and reads a native response: %s", async (wrapped) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(String(url));
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-test-key");
        expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-6-astra", stream: false, input: plainInput.input, tools: [], tool_choice: "auto", parallel_tool_calls: false });
        return Response.json(wrapped ? { code: 200, data: nativeCompletion } : nativeCompletion);
    }) as typeof fetch;

    expect(await requestChatCompletion(model, credentials, plainInput)).toEqual({ content: completion.choices[0]!.message.content, toolCalls: [], stopReason: "stop" });
    expect(calls).toEqual(["http://mark-provider.invalid/v1/responses"]);
});

test("Mark chat preserves vision, function schemas, selected tools and ordered tool-result history", async () => {
    const schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
    const toolCall = { id: "inspect-next", type: "function" as const, function: { name: "inspect_images", arguments: '{"id":"sweater-back"}' } };
    const nativeOutput = [
        { id: "rs-one", type: "reasoning", summary: [], encrypted_content: "opaque-encrypted-state" },
        { id: "fc-item-id", type: "function_call", call_id: "inspect-next", name: "inspect_images", arguments: '{"id":"sweater-back"}', status: "completed" },
    ];
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body))).toEqual({
            model: "gpt-6-astra", stream: false, include: ["reasoning.encrypted_content"],
            input: [
                { role: "system", content: "Keep garment structure unchanged." },
                { role: "user", content: [
                    { type: "input_text", text: "Compare these knits" },
                    { type: "input_image", image_url: "data:image/png;base64,AQID" },
                    { type: "input_image", image_url: "https://reference.invalid/knit.png" },
                ] },
                { type: "function_call", call_id: "inspect-first", name: "inspect_images", arguments: '{"id":"sweater-front"}' },
                { type: "function_call_output", call_id: "inspect-first", output: '{"construction":"cables"}' },
            ],
            tools: [{ type: "function", name: "inspect_images", description: "Inspect an existing garment image", parameters: schema, strict: true }],
            tool_choice: { type: "function", name: "inspect_images" },
            parallel_tool_calls: false,
        });
        return Response.json({ status: "completed", output: nativeOutput });
    }) as typeof fetch;

    expect(await requestChatCompletion(model, credentials, {
        input: [
            { role: "system", content: "Keep garment structure unchanged." },
            { role: "user", content: [{ type: "input_text", text: "Compare these knits" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }, { type: "input_image", image_url: "https://reference.invalid/knit.png" }] },
            { type: "function_call", call_id: "inspect-first", name: "inspect_images", arguments: '{"id":"sweater-front"}' },
            { type: "function_call_output", call_id: "inspect-first", output: '{"construction":"cables"}' },
        ],
        tools: [{ type: "function", name: "inspect_images", description: "Inspect an existing garment image", parameters: schema, strict: true }],
        toolChoice: { type: "function", name: "inspect_images" },
    })).toEqual({ content: "", toolCalls: [toolCall], stopReason: "tool_calls", responsesOutputItems: nativeOutput });
    expect(calls).toBe(1);
});

test.each([
    { protocol: "apimart", model_id: "gpt-6-astra", withTools: true, endpoint: "responses" },
    { protocol: "apimart", model_id: "gpt-6-astra", withTools: false, endpoint: "responses" },
    { protocol: "apimart", model_id: "gpt-6-sol", withTools: true, endpoint: "chat/completions" },
    { protocol: "openai-chat", model_id: "gpt-6-astra", withTools: true, endpoint: "chat/completions" },
])("fixed Responses routing is limited to Mark gpt-6-astra and never sets reasoning effort: %j", async ({ protocol, model_id, withTools, endpoint }) => {
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
        calls++;
        expect(String(url)).toBe(`http://mark-provider.invalid/v1/${endpoint}`);
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(model_id);
        expect(body).not.toHaveProperty("reasoning_effort"); expect(body).not.toHaveProperty("reasoning");
        expect(body.tools?.length || 0).toBe(withTools ? 1 : 0);
        return Response.json(endpoint === "responses" ? nativeCompletion : completion);
    }) as typeof fetch;
    await requestChatCompletion({ ...model, protocol, model_id }, credentials, {
        ...plainInput,
        tools: withTools ? [{ type: "function", name: "inspect_images", parameters: { type: "object", properties: {} } }] : [],
    });
    expect(calls).toBe(1);
});

test("a Mark Responses rejection is surfaced once without retry or Chat Completions fallback", async () => {
    const calls: string[] = [];
    const detail = "Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
    globalThis.fetch = (async (url) => {
        calls.push(String(url));
        return Response.json({ error: { message: detail } }, { status: 400 });
    }) as typeof fetch;
    await expect(requestChatCompletion(model, credentials, {
        ...plainInput, tools: [{ type: "function", name: "inspect_images", parameters: { type: "object", properties: {} } }],
    })).rejects.toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
    expect(calls).toEqual(["http://mark-provider.invalid/v1/responses"]);
});

test.each([false, true])("Mark Responses accepts the provider's documented choices envelope without changing endpoints: %s", async wrapped => {
    const calls: string[] = [];
    globalThis.fetch = (async url => { calls.push(String(url)); return Response.json(wrapped ? { code: 200, data: completion } : completion); }) as typeof fetch;
    expect(await requestChatCompletion(model, credentials, plainInput)).toEqual({ content: completion.choices[0]!.message.content, toolCalls: [], stopReason: "stop" });
    expect(calls).toEqual(["http://mark-provider.invalid/v1/responses"]);
});

test("Mark Responses echoes complete native output before tool results in the next request", async () => {
    const output = [
        { id: "rs-original", type: "reasoning", summary: [], encrypted_content: "opaque-do-not-reconstruct" },
        { id: "msg-intermediate", type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Inspecting.", annotations: [] }], status: "completed" },
        { id: "fc-one", type: "function_call", call_id: "call-one", name: "inspect_images", arguments: '{"id":"one"}', status: "completed" },
        { id: "fc-two", type: "function_call", call_id: "call-two", name: "inspect_images", arguments: '{"id":"two"}', status: "completed" },
    ];
    let calls = 0;
    globalThis.fetch = (async (_url, init) => {
        calls++;
        expect(JSON.parse(String(init?.body)).input).toEqual([
            ...plainInput.input, ...output,
            { type: "function_call_output", call_id: "call-one", output: "front knit" },
            { type: "function_call_output", call_id: "call-two", output: "back knit" },
        ]);
        return Response.json(nativeCompletion);
    }) as typeof fetch;
    await requestChatCompletion(model, credentials, { tools: [], input: [
        ...plainInput.input,
        { type: "responses_assistant", output },
        { type: "function_call_output", call_id: "call-one", output: "front knit" },
        { type: "function_call_output", call_id: "call-two", output: "back knit" },
    ] });
    expect(calls).toBe(1);
});

test.each([
    null,
    {},
    { choices: [] },
    { choices: [{ message: { content: "" } }] },
    { choices: [{ message: { content: "   " } }] },
    { choices: [{ message: { content: { unexpected: true } } }] },
    { choices: [{ message: { content: null, tool_calls: [{}] } }] },
    { code: 503, data: completion },
    { error: { message: "Provider rejected the request" } },
    { status: "completed", output: [] },
    { status: "failed", output: nativeCompletion.output },
    { status: "incomplete", output: [{ type: "function_call", call_id: "partial", name: "create_image", arguments: "{}" }] },
    { status: "completed", error: { message: "Nested error" }, output: nativeCompletion.output },
    { code: 200, data: { error: { message: "Wrapped error" } } },
    { status: "completed", output: [{ type: "reasoning", summary: [] }] },
    { status: "completed", output: [{ type: "function_call", id: "not-a-call-id", name: "create_image", arguments: "{}" }] },
    { status: "completed", output: [{ type: "function_call", call_id: "unfinished", name: "create_image", arguments: "{}", status: "in_progress" }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: { invalid: true } }] }] },
])("Mark chat rejects empty/error completions without replaying the paid request: %j", async (body) => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json(body); }) as unknown as typeof fetch;
    await expect(requestChatCompletion(model, credentials, plainInput)).rejects.toMatchObject({ code: "APIMART_CHAT_INVALID_RESPONSE" });
    expect(calls).toBe(1);
});

test("Mark chat reports malformed JSON without resubmission", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("not-json", { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
    await expect(requestChatCompletion(model, credentials, plainInput)).rejects.toMatchObject({ code: "APIMART_CHAT_INVALID_RESPONSE" });
    expect(calls).toBe(1);
});

test.each(["gpt-6-astra", "gpt-6-sol"])("Mark preserves response-stream transport diagnostics without replaying %s", async modelId => {
    const transportError = Object.assign(new Error("Response stream interrupted"), {
        code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1,
    });
    const error = new Error("JSON body read interrupted", { cause: transportError });
    let calls = 0;
    globalThis.fetch = (async () => {
        calls++;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error); } }), {
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    const received = await requestChatCompletion({ ...model, model_id: modelId }, credentials, plainInput).catch(error => error);
    expect(received).toBe(error);
    expect(readProviderSubmissionDiagnostics(received)).toEqual({ code: "PROVIDER_RESPONSE_STREAM_ERROR", phase: "response", attempts: 1 });
    expect(calls).toBe(1);
});

test("Mark chat refuses an unexpected event stream without a second submission", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('data: {"choices":[]}\n\n', { headers: { "content-type": "text/event-stream" } }); }) as unknown as typeof fetch;
    await expect(requestChatCompletion(model, credentials, plainInput)).rejects.toMatchObject({ code: "APIMART_CHAT_UNEXPECTED_STREAM" });
    expect(calls).toBe(1);
});

test("a Mark HTTP failure does not fall back to another protocol or resubmit", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 }); }) as unknown as typeof fetch;
    await expect(requestChatCompletion(model, credentials, plainInput)).rejects.toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
    expect(calls).toBe(1);
});
