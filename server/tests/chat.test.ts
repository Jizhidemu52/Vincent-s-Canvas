import { afterEach, describe, expect, test } from "bun:test";

import {
    buildClaudeMessagesRequest,
    buildGeminiGenerateUrl,
    ChatProtocolError,
    buildGeminiRequestBody,
    readGeminiResponse,
    requestChatCompletion,
    requestClaudeStream,
    readClaudeResponse,
    toGeminiContents,
} from "../src/routes/chat";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("Gemini native chat protocol", () => {
    test("builds the native APIMart endpoint from both root and v1 base URLs", () => {
        expect(buildGeminiGenerateUrl("https://api.apimart.ai", "gemini-3.1-pro-preview"))
            .toBe("https://api.apimart.ai/v1beta/models/gemini-3.1-pro-preview:generateContent");
        expect(buildGeminiGenerateUrl("https://api.apimart.ai/v1/", "gemini-3.1-pro-preview"))
            .toBe("https://api.apimart.ai/v1beta/models/gemini-3.1-pro-preview:generateContent");
    });

    test("converts Response input to Gemini native contents and inline images", () => {
        expect(toGeminiContents([
            { role: "system", content: "Follow the brand tone." },
            { role: "assistant", content: "Understood." },
            { role: "user", content: [{ type: "input_text", text: "Review this" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] },
        ])).toEqual([
            { role: "user", parts: [{ text: "Follow the brand tone." }] },
            { role: "model", parts: [{ text: "Understood." }] },
            { role: "user", parts: [{ text: "Review this" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
        ]);
    });

    test("rejects remote image URLs rather than sending an invalid Gemini request", () => {
        expect(() => toGeminiContents([
            { role: "user", content: [{ type: "input_image", image_url: "https://example.com/image.png" }] },
        ])).toThrow(ChatProtocolError);
    });

    test("maps canvas tools and tool results to Gemini native function calls", () => {
        const tool = { type: "function" as const, name: "canvas_get_state", description: "Read canvas", parameters: { type: "object", properties: {} } };
        const body = buildGeminiRequestBody({
            input: [
                { role: "user", content: "Read the canvas" },
                { type: "function_call", call_id: "call-1", name: "canvas_get_state", arguments: "{}", thoughtSignature: "signature-1" },
                { type: "function_call_output", call_id: "call-1", output: '{"nodes":2}' },
            ],
            tools: [tool],
            toolChoice: "required",
            webSearch: true,
        });
        expect(body).toMatchObject({
            tools: [{ functionDeclarations: [{ name: "canvas_get_state" }] }, { googleSearch: {} }],
            toolConfig: { functionCallingConfig: { mode: "ANY" } },
            contents: [
                { role: "user", parts: [{ text: "Read the canvas" }] },
                { role: "model", parts: [{ functionCall: { name: "canvas_get_state", args: {} }, thoughtSignature: "signature-1" }] },
                { role: "user", parts: [{ functionResponse: { name: "canvas_get_state", response: { nodes: 2 } } }] },
            ],
        });
        const response = readGeminiResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "canvas_get_state", args: { scope: "selected" } }, thoughtSignature: "signature-2" }] } }] });
        expect(response.toolCalls[0]?.function).toEqual({ name: "canvas_get_state", arguments: '{"scope":"selected"}' });
        expect(response.toolCalls[0]?.thoughtSignature).toBe("signature-2");
    });

    test("sends Gemini native request and reads a direct native response", async () => {
        globalThis.fetch = (async (input, init) => {
            expect(String(input)).toBe("https://api.apimart.ai/v1beta/models/gemini-3.1-pro-preview:generateContent");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
            expect(JSON.parse(String(init?.body))).toEqual({ contents: [{ role: "user", parts: [{ text: "ping" }] }] });
            return Response.json({ candidates: [{ content: { parts: [{ text: "pong" }] } }] });
        }) as typeof fetch;

        const result = await requestChatCompletion(
            { model_id: "gemini-3.1-pro-preview", base_url: "https://api.apimart.ai/v1", protocol: "gemini", encrypted_credentials: "unused" },
            { apiKey: "test-key" },
            { input: [{ role: "user", content: "ping" }], tools: [] },
        );
        expect(result).toEqual({ content: "pong", toolCalls: [] });
    });

    test("preserves strict and nested JSON Schema in the Gemini JSON-schema field", () => {
        const parameters = { type: "object", properties: { input: { type: "object", properties: { prompt: { type: "string" } }, additionalProperties: false } }, additionalProperties: false };
        const body = buildGeminiRequestBody({ input: [], tools: [{ type: "function", name: "canvas_generate_video", parameters }] });
        const declaration = (body.tools?.[0] as { functionDeclarations: Array<Record<string, unknown>> }).functionDeclarations[0];
        expect(declaration.parametersJsonSchema).toEqual(parameters);
        expect(declaration).not.toHaveProperty("parameters");
    });

    test("keeps grounded web sources with the final assistant answer", () => {
        const result = readGeminiResponse({
            candidates: [
                {
                    content: { parts: [{ text: "建议采用针织撞色条纹。" }] },
                    groundingMetadata: {
                        groundingChunks: [
                            { web: { title: "H&M knitwear trends", uri: "https://example.com/knitwear" } },
                            { web: { title: "H&M knitwear trends", uri: "https://example.com/knitwear" } },
                        ],
                    },
                },
            ],
        });

        expect(result.content).toContain("建议采用针织撞色条纹。");
        expect(result.content).toContain("联网参考：");
        expect(result.content).toContain("H&M knitwear trends: https://example.com/knitwear");
    });
});

describe("Claude Messages native protocol", () => {
    test("builds a native request with system, base64 image, tool and thinking", () => {
        const body = buildClaudeMessagesRequest({
            input: [
                { role: "system", content: "Keep the brand tone." },
                { role: "user", content: [{ type: "input_text", text: "Review this" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] },
            ],
            tools: [{ type: "function", name: "canvas_get_state", description: "Read canvas", parameters: { type: "object", properties: {} } }],
        }, { modelId: "claude-sonnet-5", maxTokens: 1024, thinking: true, stream: true });

        expect(body).toMatchObject({
            system: "Keep the brand tone.",
            max_tokens: 1024,
            stream: true,
            thinking: { type: "adaptive", display: "omitted" },
            messages: [{ role: "user", content: [{ type: "text", text: "Review this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] }],
            tools: [{ name: "canvas_get_state", input_schema: { type: "object", properties: {} } }],
        });
    });

    test("reads text and tool-use blocks without assuming the first block is text", () => {
        expect(readClaudeResponse({
            content: [
                { type: "thinking", thinking: "reasoning" },
                { type: "text", text: "Use the warm red option." },
                { type: "tool_use", id: "tool-1", name: "canvas_get_state", input: { scope: "selected" } },
            ],
        })).toMatchObject({
            content: "Use the warm red option.",
            toolCalls: [{ id: "tool-1", type: "function", function: { name: "canvas_get_state", arguments: '{"scope":"selected"}' } }],
        });
    });

    test("uses Claude 5 adaptive thinking without a legacy budget and never disables Fable", () => {
        for (const modelId of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
            for (const thinking of [true, false, undefined]) {
                const body = buildClaudeMessagesRequest({ input: [{ role: "user", content: "hi" }], tools: [] }, { modelId, maxTokens: 1024, thinking });
                expect(body.thinking).toEqual(thinking === false && modelId !== "claude-fable-5" ? { type: "disabled" } : { type: "adaptive", display: "omitted" });
                expect(body.max_tokens).toBe(1024);
                expect(JSON.stringify(body)).not.toContain("budget_tokens");
            }
        }
    });

    test("retains complete native assistant blocks and tool-result ordering", () => {
        const blocks = [
            { type: "thinking", thinking: "", signature: "opaque-test-signature" },
            { type: "text", text: "读取两个节点。" },
            { type: "tool_use", id: "one", name: "read_node", input: { id: 1 } },
            { type: "redacted_thinking", data: "opaque-test-redaction" },
            { type: "tool_use", id: "two", name: "read_node", input: { id: 2 } },
        ];
        const body = buildClaudeMessagesRequest({ input: [
            { role: "user", content: "review" },
            { type: "claude_assistant", content: blocks },
            { type: "function_call_output", call_id: "one", output: "first result" },
            { type: "function_call_output", call_id: "two", output: "second result" },
        ], tools: [] }, { modelId: "claude-fable-5", maxTokens: 2048, thinking: false });
        expect(body.messages).toEqual([
            { role: "user", content: "review" },
            { role: "assistant", content: blocks },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "first result" }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "two", content: "second result" }] },
        ]);
        expect(readClaudeResponse({ content: blocks }).claudeAssistantContent).toEqual(blocks);
    });

    test("the production Claude streaming path submits stream=true with the same verified parameters", async () => {
        const events = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
        globalThis.fetch = (async (_input, init) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-fable-5", stream: true, max_tokens: 2048, thinking: { type: "adaptive", display: "omitted" } });
            return new Response(events, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const response = await requestClaudeStream(
            { model_id: "claude-fable-5", base_url: "https://api.apimart.ai", protocol: "anthropic", encrypted_credentials: "unused" },
            { apiKey: "test-key" },
            { input: [{ role: "user", content: "hello" }], tools: [], claude: { thinking: false, maxTokens: 2048 } },
        );
        expect(await response.text()).toBe(events);
    });

    test("sends an Anthropic-native endpoint and headers", async () => {
        globalThis.fetch = (async (input, init) => {
            expect(String(input)).toBe("https://api.apimart.ai/v1/messages");
            const headers = new Headers(init?.headers);
            expect(headers.get("x-api-key")).toBe("test-key");
            expect(headers.get("anthropic-version")).toBe("2023-06-01");
            expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-sonnet-5", max_tokens: 2048, messages: [{ role: "user", content: "ping" }] });
            return Response.json({ content: [{ type: "text", text: "pong" }] });
        }) as typeof fetch;

        await expect(requestChatCompletion(
            { model_id: "claude-sonnet-5", base_url: "https://api.apimart.ai", protocol: "anthropic", encrypted_credentials: "unused" },
            { apiKey: "test-key" },
            { input: [{ role: "user", content: "ping" }], tools: [] },
        )).resolves.toEqual({ content: "pong", toolCalls: [] });
    });
});
