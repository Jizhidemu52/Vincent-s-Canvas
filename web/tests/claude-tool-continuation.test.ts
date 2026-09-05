import { afterEach, expect, mock, test } from "bun:test";

import { requestToolResponse, toolResponseToInput, type ResponseInputMessage } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
import { buildClaudeMessagesRequest, readClaudeResponse } from "../../server/src/routes/chat";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

test("Claude tool loop keeps two complete assistant turns and signatures out of visible text", async () => {
    const firstBlocks = [
        { type: "thinking", thinking: "", signature: "opaque-first-signature" },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        { type: "text", text: "先读取画布。" },
        { type: "tool_use", id: "call-one", name: "read_canvas", input: { scope: "all" } },
    ];
    const secondBlocks = [
        { type: "thinking", thinking: "", signature: "opaque-second-signature" },
        { type: "tool_use", id: "call-two", name: "read_canvas", input: { scope: "selected" } },
    ];
    const firstStream = [
        event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
        event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "opaque-first-" } }),
        event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signature" } }),
        event("content_block_start", { index: 1, content_block: firstBlocks[1] }),
        event("content_block_start", { index: 2, content_block: { type: "text", text: "" } }),
        event("content_block_delta", { index: 2, delta: { type: "text_delta", text: "先读取画布。" } }),
        event("content_block_start", { index: 3, content_block: { type: "tool_use", id: "call-one", name: "read_canvas", input: {} } }),
        event("content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '{"scope":' } }),
        event("content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '"all"}' } }),
        event("message_delta", { delta: { stop_reason: "tool_use" } }),
        event("message_stop", {}),
    ].join("");

    const submitted: Array<ReturnType<typeof buildClaudeMessagesRequest>> = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body));
        const body = buildClaudeMessagesRequest(payload, { modelId: payload.modelId, maxTokens: payload.claude.maxTokens, thinking: payload.claude.thinking });
        submitted.push(body);
        expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" });
        if (submitted.length === 1) return new Response(firstStream, { headers: { "content-type": "text/event-stream" } });
        if (submitted.length === 2) return Response.json(readClaudeResponse({ content: secondBlocks, stop_reason: "tool_use" }));
        return Response.json(readClaudeResponse({ content: [{ type: "text", text: "两个步骤都已完成。" }], stop_reason: "end_turn" }));
    }) as typeof fetch;

    const config = { ...defaultConfig, model: "claude-fable-5", textModel: "claude-fable-5", systemPrompt: "", claudeThinking: "false" };
    let messages: ResponseInputMessage[] = [{ role: "user", content: "分两步读取画布" }];
    const visible: string[] = [];
    const first = await requestToolResponse(config, messages, [], "auto", (text) => visible.push(text));
    expect(first.claudeAssistantContent).toEqual(firstBlocks);
    messages = [...messages, ...toolResponseToInput(first), { role: "tool", tool_call_id: "call-one", content: "first result" }];
    const second = await requestToolResponse(config, messages, [], "auto", (text) => visible.push(text));
    messages = [...messages, ...toolResponseToInput(second), { role: "tool", tool_call_id: "call-two", content: "second result" }];
    const final = await requestToolResponse(config, messages, [], "auto", (text) => visible.push(text));

    expect(final.content).toBe("两个步骤都已完成。");
    expect(submitted).toHaveLength(3);
    expect(submitted[1]?.messages[1]).toEqual({ role: "assistant", content: firstBlocks });
    expect(submitted[2]?.messages.slice(0, 3)).toEqual(submitted[1]?.messages);
    expect(submitted[2]?.messages[3]).toEqual({ role: "assistant", content: secondBlocks });
    expect(JSON.stringify(visible)).not.toContain("opaque-");
    expect(JSON.stringify(first.toolCalls)).not.toContain("signature");
});

test("Gemini tool continuation keeps its function thoughtSignature without Claude-specific blocks", () => {
    expect(toolResponseToInput({ toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" }, thoughtSignature: "gemini-signature" }] })).toEqual([
        { type: "function_call", call_id: "call", name: "read", arguments: "{}", thoughtSignature: "gemini-signature" },
    ]);
});
