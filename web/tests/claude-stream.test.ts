import { afterEach, expect, mock, test } from "bun:test";

import { requestImageQuestion, requestToolResponse, isClaudeModel, readClaudeSseResponse } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;

function withModelConfig(handler: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>): typeof fetch {
    return ((url, init) => String(url) === "/api/models"
        ? Promise.resolve(Response.json({ models: ["claude-opus-5", "claude-sonnet-5"].map(model => ({ id: model, modelId: model, name: model, capabilities: ["chat"], creditCost: 0, rmbCost: 0 })), tools: [], prices: [] }))
        : handler(url, init)) as typeof fetch;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("recognizes only the configured Claude 5 model identifiers", () => {
    expect(isClaudeModel("claude-opus-5")).toBe(true);
    expect(isClaudeModel("claude-sonnet-5")).toBe(true);
    expect(isClaudeModel("claude-fable-5")).toBe(true);
    expect(isClaudeModel("claude-fable-5-1")).toBe(true);
    expect(isClaudeModel("claude-sonnet-5-5")).toBe(true);
    expect(isClaudeModel("d5000000-0000-4000-8000-000000000010")).toBe(false);
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

test.each(["canvas-chat", "gpt-chat"])("APIMart Sonnet UUID retains its provider identity and activates Claude SSE for %s", async tool => {
    const modelId = "d5000000-0000-4000-8000-000000000010";
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: modelId, modelId, parameterModelId: "claude-sonnet-5-5", name: "claude-sonnet-5-5", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [], prices: [] });
        expect(String(url)).toBe("/api/chat/responses");
        requests.push(JSON.parse(String(init?.body)));
        return new Response([
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-sonnet-signature"}}\n\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"已读取画布。"}}\n\n',
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"inspect-one","name":"inspect_images","input":{}}}\n\n',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"image_ids\\":[\\"one\\"]}"}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
            'data: {"type":"message_stop"}\n\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const deltas: string[] = [];
    const result = await requestToolResponse({ ...defaultConfig, model: modelId, textModel: modelId, systemPrompt: "", claudeMaxTokens: "4096", claudeThinking: "false", claudeStream: "true" }, [{ role: "user", content: "只分析，不生图" }], [], "auto", text => deltas.push(text), { tool });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ modelId, toolKey: tool, claude: { stream: true, thinking: false, maxTokens: 4096 } });
    expect(requests[0]!.modelId).not.toBe("claude-sonnet-5-5");
    expect(result.content).toBe("已读取画布。");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls[0]!.function.arguments).toBe('{"image_ids":["one"]}');
    expect(result.claudeAssistantContent?.[0]).toEqual({ type: "thinking", thinking: "", signature: "opaque-sonnet-signature" });
    expect(deltas.join(" ")).not.toContain("opaque-sonnet-signature");
});

test("APIMart Astra UUID remains a non-Claude request", async () => {
    const modelId = "d5000000-0000-4000-8000-000000000004";
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: modelId, modelId, parameterModelId: "gpt-6-astra", name: "gpt-6-astra", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [], prices: [] });
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(body.modelId).toBe(modelId);
        expect(body).not.toHaveProperty("claude");
        return Response.json({ content: "Astra reply", toolCalls: [] });
    }) as typeof fetch;
    expect(await requestToolResponse({ ...defaultConfig, model: modelId, textModel: modelId }, [{ role: "user", content: "Hello" }], [])).toEqual({ content: "Astra reply", toolCalls: [] });
    expect(calls).toBe(1);
});

test("reports tool activity before its arguments finish without exposing or executing partial JSON", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
    globalThis.fetch = withModelConfig(mock(async () => response));
    const deltas: string[] = [];
    const names: string[] = [];
    let settled = false;
    let started!: () => void;
    const startSeen = new Promise<void>((resolve) => { started = resolve; });
    const resultPromise = requestToolResponse({ ...defaultConfig, model: "claude-opus-5" }, [{ role: "user", content: "改成绿色" }], [], "auto", (text) => deltas.push(text), {
        onToolCallStart(name) { names.push(name); started(); },
    }).then((result) => { settled = true; return result; });
    const event = (value: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "create-one", name: "create_image", input: {} } });
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"prompt":' } });
    await startSeen;
    expect(names).toEqual(["create_image"]);
    expect(settled).toBe(false);
    expect(deltas).toEqual([]);
    event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"绿色"}' } });
    event({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    controller.close();
    const result = await resultPromise;
    expect(result.toolCalls[0]?.function.arguments).toBe('{"prompt":"绿色"}');
    expect(names).toEqual(["create_image"]);
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
    globalThis.fetch = withModelConfig(fetchMock);

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
    globalThis.fetch = withModelConfig(fetchMock);

    await expect(requestImageQuestion(
        { ...defaultConfig, model: "claude-sonnet-5", textModel: "claude-sonnet-5", claudeMaxTokens: "16384" },
        [{ role: "user", content: "请分析附件" }],
        () => {},
    )).rejects.toThrow("Claude 已耗尽推理额度");

    expect(fetchMock).toHaveBeenCalledTimes(1);
});
