import { afterEach, expect, mock, test } from "bun:test";

import { requestImageQuestion, isClaudeModel, readClaudeSseResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("recognizes only the configured Claude 5 model identifiers", () => {
    expect(isClaudeModel("claude-opus-5")).toBe(true);
    expect(isClaudeModel("claude-sonnet-5")).toBe(true);
    expect(isClaudeModel("claude-fable-5")).toBe(true);
    expect(isClaudeModel("gemini-3.1-pro-preview")).toBe(false);
});

test("reads native Claude SSE text and tool-use blocks without a response wrapper", async () => {
    const chunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"canvas_get_state"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"full\\":true}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const response = new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
        },
    }), { headers: { "content-type": "text/event-stream" } });
    const deltas: string[] = [];

    const result = await readClaudeSseResponse(response, (text) => deltas.push(text));

    expect(deltas).toEqual(["你好"]);
    expect(result).toMatchObject({
        content: "你好",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "canvas_get_state", arguments: '{"full":true}' } }],
    });
});

test("reads a compatible SSE text block that carries its text at block start", async () => {
    const response = new Response('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"直接文本"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
    });

    const result = await readClaudeSseResponse(response);

    expect(result).toEqual({ content: "直接文本", toolCalls: [] });
});

test("preserves Claude max_tokens termination when thinking consumes the visible response budget", async () => {
    const response = new Response([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"分析附件"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(""), { headers: { "content-type": "text/event-stream" } });

    const result = await readClaudeSseResponse(response);

    expect(result).toEqual({ content: "", toolCalls: [], stopReason: "max_tokens" });
});

test("retries a zero-text Claude response that stopped at max_tokens with a larger output budget", async () => {
    const exhausted = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const completed = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"表格已读取"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
    const fetchMock = mock(async () => new Response(fetchMock.mock.calls.length === 1 ? exhausted : completed, {
        headers: { "content-type": "text/event-stream" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const answer = await requestImageQuestion(
        { ...defaultConfig, model: "claude-sonnet-5", textModel: "claude-sonnet-5", claudeMaxTokens: "2048" },
        [{ role: "user", content: "请分析这个表格附件" }],
        () => {},
    );

    expect(answer).toBe("表格已读取");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).claude.maxTokens).toBe(8192);
});

test("does not replay an empty Claude response when the configured budget is already at the maximum", async () => {
    const exhausted = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n';
    const fetchMock = mock(async () => new Response(exhausted, { headers: { "content-type": "text/event-stream" } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(requestImageQuestion(
        { ...defaultConfig, model: "claude-sonnet-5", textModel: "claude-sonnet-5", claudeMaxTokens: "16384" },
        [{ role: "user", content: "请分析附件" }],
        () => {},
    )).rejects.toThrow("Claude 已耗尽推理额度");

    expect(fetchMock).toHaveBeenCalledTimes(1);
});
