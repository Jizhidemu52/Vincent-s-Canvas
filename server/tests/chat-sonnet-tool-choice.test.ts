import { afterEach, expect, spyOn, test } from "bun:test";
import { prepareChatProfileInput } from "../src/prompt-chat-profiles";
import * as providerTransport from "../src/provider-submission-transport";
import { buildClaudeMessagesRequest, requestChatCompletion, requestClaudeStream, type ResponseTool } from "../src/routes/chat";

let restoreTransport: (() => void) | undefined;
afterEach(() => { restoreTransport?.(); restoreTransport = undefined; });

const tools: ResponseTool[] = [
    { type: "function", name: "canvas_generate_image", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
    { type: "function", name: "canvas_delete_nodes", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } },
];
const input = [{ role: "system" as const, content: "Keep the selected original image and all constraints." }, { role: "user" as const, content: "只改领口颜色。" }];
const model = { model_id: "claude-sonnet-5-5", protocol: "apimart", base_url: "https://never-called.invalid/v1", encrypted_credentials: null };

test.each([false, true])("Sonnet forced named tool preserves its allowed scope without unsupported wire choice (stream=%s)", stream => {
    const source = { input, tools, toolChoice: { type: "function", name: "canvas_generate_image" } };
    const before = JSON.stringify(source);
    const wire = buildClaudeMessagesRequest(source, { modelId: model.model_id, maxTokens: 2048, thinking: false, stream });
    expect(wire.tool_choice).toEqual({ type: "auto" });
    expect(wire.tools).toEqual([{ name: "canvas_generate_image", input_schema: tools[0]!.parameters }]);
    expect(wire.system).toContain(input[0]!.content);
    expect(wire.system).toMatch(/call[^\n]*canvas_generate_image/i);
    expect(wire.system).not.toContain("canvas_delete_nodes");
    expect(wire.messages).toEqual([{ role: "user", content: "只改领口颜色。" }]);
    expect(wire.output_config).toEqual({ effort: "low" });
    expect(wire).not.toHaveProperty("thinking");
    expect(JSON.stringify(source)).toBe(before);
});

test("Sonnet required tools use auto without broadening the allowed set", () => {
    const wire = buildClaudeMessagesRequest({ input, tools, toolChoice: "required" }, { modelId: model.model_id, maxTokens: 2048 });
    expect(wire.tool_choice).toEqual({ type: "auto" });
    expect(wire.tools?.map(tool => tool.name)).toEqual(["canvas_generate_image", "canvas_delete_nodes"]);
    expect(wire.system).toContain(input[0]!.content);
    expect(wire.system).toMatch(/call[^\n]*(?:available|provided)[^\n]*tool/i);
});

test.each([undefined, "auto", "none", { type: "none" }])("Sonnet ordinary choice %j is not forced or given extra instructions", toolChoice => {
    const wire = buildClaudeMessagesRequest({ input, tools, toolChoice }, { modelId: model.model_id, maxTokens: 2048 });
    expect(wire.tool_choice).toEqual({ type: toolChoice === "none" || typeof toolChoice === "object" ? "none" : "auto" });
    expect(wire.tools?.map(tool => tool.name)).toEqual(["canvas_generate_image", "canvas_delete_nodes"]);
    expect(wire.system).toBe(input[0]!.content);
});

test.each(["claude-sonnet-5", "claude-fable-5", "claude-sonnet-4-6"])("%s keeps its existing forced-tool encoding and tool set", modelId => {
    for (const [toolChoice, expected] of [[{ type: "function", name: "canvas_generate_image" }, { type: "tool", name: "canvas_generate_image" }], ["required", { type: "any" }]] as const) {
        const wire = buildClaudeMessagesRequest({ input, tools, toolChoice }, { modelId, maxTokens: 2048 });
        expect(wire.tool_choice).toEqual(expected);
        expect(wire.tools?.map(tool => tool.name)).toEqual(["canvas_generate_image", "canvas_delete_nodes"]);
        expect(wire.system).toBe(input[0]!.content);
    }
});

test.each([false, true])("an unknown Sonnet forced tool is rejected before provider submission (stream=%s)", async stream => {
    let submitted = 0;
    const transport = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async () => { submitted++; throw new Error("Unexpected provider submission"); });
    restoreTransport = () => transport.mockRestore();
    const request = stream ? requestClaudeStream : requestChatCompletion;
    await expect(request(model, {}, { input, tools, toolChoice: { type: "function", name: "unknown_tool" } })).rejects.toMatchObject({ code: "CLAUDE_TOOL_CHOICE_INVALID" });
    expect(submitted).toBe(0);
});

test.each([
    { tools: [], toolChoice: "required" },
    { tools: [tools[0]!, tools[0]!], toolChoice: { type: "function", name: "canvas_generate_image" } },
])("Sonnet rejects an empty required set or an ambiguous named tool", request => {
    expect(() => buildClaudeMessagesRequest({ input, ...request, tools: [...request.tools] }, { modelId: model.model_id, maxTokens: 2048 })).toThrow(expect.objectContaining({ code: "CLAUDE_TOOL_CHOICE_INVALID" }));
});

test("canvas repair preserves the exact tool-use/result pair with one allowed tool and auto wire choice", async () => {
    const call = { type: "tool_use", id: "image-before-submission", name: "canvas_generate_image", input: { prompt: "Change the collar only." } };
    const output = JSON.stringify({ ok: false, data: { phase: "image_preflight", submitted: false, expectedMode: "update" } });
    const prepared = await prepareChatProfileInput({
        profile: "canvas-assistant", toolKey: "canvas-chat", tools: [],
        profileContext: { stage: "repair-image-contract", userText: "只改领口颜色。", editContext: { selectedTarget: { mode: "original", baseImageIds: ["edit-original-0"] } } },
        input: [{ role: "user", content: "只改领口颜色。" }, { type: "claude_assistant", content: [call] }, { type: "function_call_output", call_id: call.id, output }],
    }, async () => "Preserve the requested garment structure.");
    const wire = buildClaudeMessagesRequest(prepared.input, { modelId: model.model_id, maxTokens: 2048, thinking: false });
    expect(wire.tool_choice).toEqual({ type: "auto" });
    expect(wire.tools?.map(tool => tool.name)).toEqual(["canvas_generate_image"]);
    expect(wire.messages.slice(-2)).toEqual([{ role: "assistant", content: [call] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: output }] }]);
});

test("auto compatibility does not fabricate a tool call or resubmit when the model replies with text", async () => {
    let submitted = 0;
    const transport = spyOn(providerTransport, "fetchProviderSubmission").mockImplementation(async () => { submitted++; return Response.json({ content: [{ type: "text", text: "Missing required source." }], stop_reason: "end_turn" }); });
    restoreTransport = () => transport.mockRestore();
    const result = await requestChatCompletion(model, {}, { input, tools, toolChoice: { type: "function", name: "canvas_generate_image" } });
    expect(result).toMatchObject({ content: "Missing required source.", toolCalls: [], stopReason: "end_turn" });
    expect(submitted).toBe(1);
});
