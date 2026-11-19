import { afterEach, expect, test } from "bun:test";
import { readClaudeSseResponse, requestToolResponse, toolResponseToInput, type ToolResponseResult } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
import { ImageAgentPlanningError } from "../../shared/image-agent-iteration";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { ...defaultConfig, model: "waiting-fixture", textModel: "waiting-fixture", systemPrompt: "" };
const frame = (value: Record<string, unknown>) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const waiting = (message = "正在等待对话模型…") => frame({ type: "chat_waiting", message });
const completed: ToolResponseResult = { content: "已整理修改要求。", toolCalls: [{ id: "edit-one", type: "function", function: { name: "edit_image", arguments: '{"prompt":"衣身改蓝色"}' }, thoughtSignature: "opaque-thought-signature" }] };
const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

function serve(response: () => Response) {
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: config.model, modelId: config.model, name: "fixture", capabilities: ["chat", "vision"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: config.model, enabled: true }], prices: [] });
        expect(String(url)).toBe("/api/chat/responses");
        requests.push(init!);
        return response();
    }) as typeof fetch;
    return requests;
}

test.each(["creative-chat", "canvas-assistant"] as const)("%s opts into waiting SSE without showing heartbeat or provider metadata as answer text", async chatProfile => {
    const output = [{ type: "reasoning", id: "reasoning-one", encrypted_content: "opaque-reasoning" }, { type: "function_call", call_id: "edit-one", name: "edit_image", arguments: completed.toolCalls[0]!.function.arguments }];
    const requests = serve(() => stream(waiting() + waiting("上游仍在处理，本次没有重新发送。") + frame({ type: "chat_result", result: { ...completed, responsesOutputItems: output, privateRules: "never-expose", usage: { hidden: true } } })));
    const deltas: string[] = [], phases: string[] = [], tools: string[] = [];
    const result = await requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", value => deltas.push(value), { chatProfile, onChatWaiting: value => phases.push(value), onToolCallStart: value => tools.push(value) });
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.headers).get("Accept")).toBe("text/event-stream");
    expect(result).toEqual({ ...completed, responsesOutputItems: output });
    expect(toolResponseToInput(result)).toEqual([{ type: "responses_assistant", output }]);
    expect(deltas).toEqual([completed.content]);
    expect(phases).toEqual(["正在等待对话模型…", "上游仍在处理，本次没有重新发送。"]);
    expect(tools).toEqual([]);
    expect(JSON.stringify(deltas)).not.toMatch(/opaque|never-expose|privateRules/);
});

test("non-profile JSON requests retain the existing transport without a waiting-stream opt-in", async () => {
    const result = { content: "普通回复", toolCalls: [] };
    const requests = serve(() => Response.json(result));
    expect(await requestToolResponse(config, [{ role: "user", content: "你好" }], [])).toEqual(result);
    expect(new Headers(requests[0]!.headers).has("Accept")).toBe(false);
});

test("a complete chat_result is terminal even when the underlying connection stays open", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(waiting() + frame({ type: "chat_result", result: completed }))); },
        cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    expect(await readClaudeSseResponse(response, undefined, undefined, { strictProfile: true })).toEqual(completed);
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
});

test("byte-split UTF-8 and CRLF SSE keep waiting messages separate from the final answer", async () => {
    const bytes = new TextEncoder().encode((waiting() + frame({ type: "chat_result", result: completed })).replace(/\n/g, "\r\n"));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const phases: string[] = [], deltas: string[] = [];
    expect(await readClaudeSseResponse(response, value => deltas.push(value), undefined, { onChatWaiting: value => phases.push(value) })).toEqual(completed);
    expect(phases).toEqual(["正在等待对话模型…"]);
    expect(deltas).toEqual([]);
});

test.each([
    waiting(),
    waiting() + 'event: chat_result\ndata: {"type":"chat_result","result":',
    waiting() + frame({ type: "chat_result", result: completed }).trimEnd(),
    frame({ type: "chat_result", result: completed }).trimEnd(),
    waiting() + 'data: [DONE]\n\n',
])("missing or truncated final result rejects without retry %#", async text => {
    const requests = serve(() => stream(text));
    const deltas: string[] = [];
    await expect(requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", value => deltas.push(value), { chatProfile: "creative-chat" })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(deltas).toEqual([]);
});

test.each([
    null, [], {}, { content: "ok" }, { content: 1, toolCalls: [] }, { content: "ok", toolCalls: {} }, { content: " ", toolCalls: [] },
    ...[null, {}, { ...completed.toolCalls[0], id: "" }, { ...completed.toolCalls[0], type: "unknown" }, { ...completed.toolCalls[0], function: null },
        { ...completed.toolCalls[0], function: { name: "", arguments: "{}" } }, { ...completed.toolCalls[0], function: { name: "edit_image", arguments: {} } },
        { ...completed.toolCalls[0], function: { name: "edit_image", arguments: " " } }, { ...completed.toolCalls[0], thoughtSignature: 1 }].map(call => ({ content: "ok", toolCalls: [call] })),
    { ...completed, toolCalls: [completed.toolCalls[0], completed.toolCalls[0]] },
    { ...completed, stopReason: 1 }, { ...completed, stopReason: "max_tokens" }, { ...completed, stopReason: "incomplete" },
    { ...completed, responsesOutputItems: "opaque" }, { ...completed, responsesOutputItems: [null] }, { ...completed, claudeAssistantContent: [[]] },
])("malformed chat_result is rejected before any content becomes visible %#", async result => {
    const requests = serve(() => stream(waiting() + frame({ type: "chat_result", result })));
    const deltas: string[] = [];
    await expect(requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", value => deltas.push(value), { chatProfile: "creative-chat" })).rejects.toThrow("格式不完整");
    expect(requests).toHaveLength(1);
    expect(deltas).toEqual([]);
});

test.each([
    waiting() + frame({ type: "message_stop" }),
    waiting() + frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "not-a-result" } }),
    frame({ type: "chat_result", result: completed }) + frame({ type: "chat_result", result: completed }),
    frame({ type: "chat_result", result: completed }) + waiting(),
])("mixed protocols or duplicate final results in a chunk never succeed %#", async text => {
    await expect(readClaudeSseResponse(stream(text), undefined, undefined, { strictProfile: true })).rejects.toThrow("对话流包含");
});

test("error after waiting preserves the safe message and never retries", async () => {
    const requests = serve(() => stream(waiting() + frame({ type: "error", error: { code: "CHAT_REQUEST_TIMEOUT", message: "对话模型处理超时，本次没有重发。" } })));
    const deltas: string[] = [];
    await expect(requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", value => deltas.push(value), { chatProfile: "creative-chat" })).rejects.toThrow("本次没有重发");
    expect(requests).toHaveLength(1);
    expect(deltas).toEqual([]);
});

test("waiting SSE retains explicit safe planning refusals without retrying them in the transport", async () => {
    const requests = serve(() => stream(waiting() + frame({ type: "error", error: { code: "IMAGE_AGENT_ARGUMENTS_INVALID", message: "规划参数无效", repairable: true, submitted: false } })));
    await expect(requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", undefined, { chatProfile: "creative-chat" })).rejects.toBeInstanceOf(ImageAgentPlanningError);
    expect(requests).toHaveLength(1);
});

test("tool argument validation still runs after a complete waiting-stream result", async () => {
    const requests = serve(() => stream(waiting() + frame({ type: "chat_result", result: { content: "", toolCalls: [{ ...completed.toolCalls[0], function: { name: "edit_image", arguments: '{"prompt":' } }] } })));
    await expect(requestToolResponse(config, [{ role: "user", content: "继续改图" }], [], "auto", undefined, { chatProfile: "creative-chat" })).rejects.toBeInstanceOf(ImageAgentPlanningError);
    expect(requests).toHaveLength(1);
});

test("transport interruption after heartbeat cancels and releases the reader without a result", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(waiting())); controller.error(new DOMException("stream aborted", "AbortError")); } }));
    await expect(readClaudeSseResponse(response)).rejects.toMatchObject({ name: "AbortError" });
    expect(response.body!.locked).toBe(false);
});

test("malformed waiting messages are not displayed and do not replace the final result", async () => {
    const phases: string[] = [];
    const response = stream(frame({ type: "chat_waiting", message: { privateRules: "hidden" } }) + frame({ type: "chat_waiting", message: "x".repeat(301) }) + frame({ type: "chat_result", result: { content: "有效回复", toolCalls: [] } }));
    expect(await readClaudeSseResponse(response, undefined, undefined, { onChatWaiting: value => phases.push(value) })).toEqual({ content: "有效回复", toolCalls: [] });
    expect(phases).toEqual([]);
});
