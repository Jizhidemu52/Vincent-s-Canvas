import { afterEach, describe, expect, test } from "bun:test";

import {
    buildGeminiGenerateUrl,
    ChatProtocolError,
    buildGeminiRequestBody,
    readGeminiResponse,
    requestChatCompletion,
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
        });
        expect(body).toMatchObject({
            tools: [{ functionDeclarations: [{ name: "canvas_get_state" }] }],
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
});
