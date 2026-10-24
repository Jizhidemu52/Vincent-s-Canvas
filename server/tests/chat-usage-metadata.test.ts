import { expect, test } from "bun:test";
import { readChatUsage, readGeminiResponse, requestChatCompletion } from "../src/routes/chat";

test("missing and invalid accounting stays unknown rather than zero or an estimate", () => {
    for (const body of [undefined, null, {}, { usage: {} }, { usage: { input_tokens: -1, output_tokens: 2.5, cost: "0.01", currency: "dollars" } }]) expect(readChatUsage(body)).toBeUndefined();
    expect(readChatUsage({ usage: { input_tokens: 0, output_tokens: 0, actual_cost: 0, currency: "usd" } })).toEqual({ inputTokens: 0, outputTokens: 0, actualCost: 0, currency: "USD" });
    expect(readChatUsage({ usage: { input_tokens: 4 } })).toEqual({ inputTokens: 4 });
});

test("provider-specific token fields include Claude cached inputs and Gemini thought output", () => {
    expect(readChatUsage({ usage: { prompt_tokens: 21, completion_tokens: 8 } })).toEqual({ inputTokens: 21, outputTokens: 8 });
    expect(readChatUsage({ usage: { input_tokens: 21, output_tokens: 8, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } }, "anthropic")).toEqual({ inputTokens: 91, outputTokens: 8 });
    expect(readChatUsage({ usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 8, thoughtsTokenCount: 4, totalTokenCount: 33 } }, "gemini")).toEqual({ inputTokens: 21, outputTokens: 12 });
    expect(readChatUsage({ usage: { cost: { amount: 0.0125, currency: "cny" } } })).toEqual({ actualCost: 0.0125, currency: "CNY" });
});

test.each([
    { protocol: "openai", model: "gpt-6-astra", body: { output_text: "Ready", usage: { input_tokens: 21, output_tokens: 8, actual_cost: 0.01, currency: "USD" } } },
    { protocol: "openai-chat", model: "chat-model", body: { choices: [{ message: { content: "Ready" }, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 8, actual_cost: 0.01, currency: "USD" } } },
    { protocol: "anthropic", model: "claude-sonnet-5", body: { content: [{ type: "text", text: "Ready" }], stop_reason: "end_turn", usage: { input_tokens: 21, output_tokens: 8, actual_cost: 0.01, currency: "USD" } } },
    { protocol: "apimart", model: "gpt-6-astra", body: { code: 200, data: { output_text: "Ready", status: "completed" }, usage: { input_tokens: 21, output_tokens: 8 }, actual_cost: 0.01, currency: "USD" } },
    { protocol: "apimart", model: "other-chat-model", body: { code: 200, data: { choices: [{ message: { content: "Ready" } }] }, usage: { prompt_tokens: 21, completion_tokens: 8 }, actual_cost: 0.01, currency: "USD" } },
    { protocol: "gemini", model: "gemini-test", body: { candidates: [{ content: { parts: [{ text: "Ready" }] } }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 8 }, actual_cost: 0.01, currency: "USD" } },
])("$protocol/$model adapter retains positive usage metadata in one submission", async ({ protocol, model, body }) => {
    let calls = 0;
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return Response.json(body); } });
    try {
        const result = await requestChatCompletion({ protocol, model_id: model, base_url: `http://127.0.0.1:${provider.port}/v1`, encrypted_credentials: null }, { apiKey: "fixture-only" }, { input: [{ role: "user", content: "Hi" }], tools: [] });
        expect(result.content).toBe("Ready");
        expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 8, actualCost: 0.01, currency: "USD" });
        expect(calls).toBe(1);
    } finally { provider.stop(true); }
});

test("private Gemini output strips thought text while retaining function-call signatures", () => {
    const result = readGeminiResponse({ candidates: [{ content: { parts: [
        { text: "private reasoning", thought: true }, { text: "已完成。" },
        { functionCall: { name: "canvas_get_state", args: {} }, thoughtSignature: "opaque-gemini-signature" },
    ] } }] }, { privateProfile: true });
    expect(result.content).toBe("已完成。");
    expect(result.toolCalls[0]?.thoughtSignature).toBe("opaque-gemini-signature");
    expect(JSON.stringify(result)).not.toContain("private reasoning");
});
