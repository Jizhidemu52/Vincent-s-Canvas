import { afterEach, expect, mock, test } from "bun:test";

import { requestToolResponse, toolResponseToInput, type ResponseInputMessage, type ToolResponseResult } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Responses continuation keeps native reasoning, messages, and two calls before their matching results", async () => {
    const output = [
        { type: "reasoning", id: "rs-native", status: "completed", summary: [], encrypted_content: "opaque-encrypted-reasoning" },
        { type: "message", id: "msg-native", status: "completed", role: "assistant", content: [{ type: "output_text", text: "读取画布和选区。", annotations: [] }] },
        { type: "function_call", id: "fc-native-one", call_id: "call-one", name: "canvas_get_state", arguments: "{}", status: "completed" },
        { type: "function_call", id: "fc-native-two", call_id: "call-two", name: "canvas_get_selection", arguments: "{}", status: "completed" },
    ];
    const firstResult: ToolResponseResult = {
        content: "读取画布和选区。",
        toolCalls: output.filter((item) => item.type === "function_call").map((item) => ({ id: item.call_id!, type: "function", function: { name: item.name!, arguments: item.arguments! } })),
        responsesOutputItems: output,
    };
    const modelId = "d5000000-0000-4000-8000-000000000004";
    const submitted: Array<{ modelId: string; input: unknown[] }> = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === "/api/models") return Response.json({ models: [{ id: modelId, modelId, name: "aplmart-gpt6-astra", capabilities: ["chat"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "gpt-chat", modelConfigId: modelId, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }], prices: [] });
        expect(String(url)).toBe("/api/chat/responses");
        submitted.push(JSON.parse(String(init?.body)));
        return Response.json(submitted.length === 1 ? firstResult : { content: "两项已完成。", toolCalls: [] });
    }) as typeof fetch;

    const config = { ...defaultConfig, model: modelId, textModel: modelId, systemPrompt: "" };
    const initial: ResponseInputMessage[] = [{ role: "user", content: "读取画布和选区" }];
    const visible: string[] = [];
    const first = await requestToolResponse(config, initial, [], "auto", (text) => visible.push(text));
    const continuation = toolResponseToInput(first);
    expect(continuation).toEqual([{ type: "responses_assistant", output }]);
    expect((continuation[0] as { output: unknown }).output).toBe(first.responsesOutputItems);
    const final = await requestToolResponse(config, [
        ...initial,
        ...continuation,
        { role: "tool", tool_call_id: "call-one", content: '{"nodes":[]}' },
        { role: "tool", tool_call_id: "call-two", content: '{"selected":[]}' },
    ], [], "auto", (text) => visible.push(text));

    expect(final.content).toBe("两项已完成。");
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.modelId).toBe(modelId);
    expect(submitted[1]?.input).toEqual([
        ...submitted[0]!.input,
        { type: "responses_assistant", output },
        { type: "function_call_output", call_id: "call-one", output: '{"nodes":[]}' },
        { type: "function_call_output", call_id: "call-two", output: '{"selected":[]}' },
    ]);
    expect(visible).toEqual(["读取画布和选区。", "两项已完成。"]);
    expect(JSON.stringify(visible)).not.toContain("opaque-encrypted-reasoning");
    expect(first.responsesOutputItems).toEqual(output);
});

test("native Responses output takes precedence without synthesizing function calls or Claude blocks", () => {
    const output = [{ type: "reasoning", id: "rs", encrypted_content: "opaque" }, { type: "function_call", id: "fc", call_id: "call", name: "read", arguments: "{}", status: "completed" }];
    expect(toolResponseToInput({
        responsesOutputItems: output,
        claudeAssistantContent: [{ type: "tool_use", id: "different", name: "read", input: {} }],
        toolCalls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
    })).toEqual([{ type: "responses_assistant", output }]);
});
