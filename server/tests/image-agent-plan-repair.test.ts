import { expect, test } from "bun:test";
import { ImageAgentArgumentsError, imageAgentRepairMetadata } from "../src/image-agent-profile";
import { CANVAS_ASSISTANT_SYSTEM_PROMPT, prepareChatProfileInput, validateChatProfileOutput } from "../src/prompt-chat-profiles";
import { imageAgentClaudeStream } from "../src/image-agent-stream";
import { PromptOptimizationError } from "../src/prompt-safety";
import { ChatStreamOutcome } from "../src/chat-billing";

const encoder = new TextEncoder();
const frame = (event: object) => `event: x\ndata: ${JSON.stringify(event)}\n\n`;
const start = { type: "message_start", message: { role: "assistant" } };
const toolStart = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "edit", name: "edit_image", input: {} } };
const stop = { type: "content_block_stop", index: 0 };
const terminal = [{ type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" }];
const profile = () => prepareChatProfileInput({
    profile: "canvas-assistant", toolKey: "canvas-chat", tools: [], input: [{ role: "user", content: "把袖口改为罗纹" }],
    profileContext: { stage: "plan", currentUserText: "把袖口改为罗纹", newCreation: false, imageCatalog: [], previewImageIds: [], workNote: "" },
});
const result = (argumentsText: string, name = "edit_image") => ({ content: "", toolCalls: [{ id: "edit", type: "function" as const, function: { name, arguments: argumentsText } }] });

test.each(['{"prompt":', '{"prompt":"改袖口","prompt":"换背景"}', '{"prompt":"改袖口","pro\\u006dpt":"换背景"}', '{"prompt":""}', '{"prompt":"改袖口","unknown":true}'])
("completed invalid plan arguments are fixed, public and repairable: %s", async argumentsText => {
    const prepared = await profile();
    let rejected: unknown;
    try { validateChatProfileOutput(result(argumentsText), prepared.privateRules); } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(ImageAgentArgumentsError);
    expect(rejected).toMatchObject({ code: "IMAGE_AGENT_ARGUMENTS_INVALID", status: 422, repairable: true, submitted: false });
    expect(imageAgentRepairMetadata(rejected)).toEqual({ repairable: true, submitted: false });
    expect((rejected as Error).message).not.toContain(argumentsText);
});

test("privacy and undeclared tools are not made repairable, and error-code spoofing is ignored", async () => {
    const prepared = await profile();
    for (const value of [result(`{"prompt":${JSON.stringify(CANVAS_ASSISTANT_SYSTEM_PROMPT)}`), result('{}', 'unknown_tool')]) {
        let rejected: unknown;
        try { validateChatProfileOutput(value, prepared.privateRules); } catch (error) { rejected = error; }
        expect(rejected).toBeInstanceOf(PromptOptimizationError);
        expect(imageAgentRepairMetadata(rejected)).toEqual({});
    }
    expect(imageAgentRepairMetadata(new PromptOptimizationError("IMAGE_AGENT_ARGUMENTS_INVALID", "untrusted code"))).toEqual({});
    expect(imageAgentRepairMetadata({ code: "IMAGE_AGENT_ARGUMENTS_INVALID", repairable: true, submitted: false })).toEqual({});
});

test.each(['{"prompt":', '{"prompt":"改袖口","prompt":"换背景"}', '{"prompt":""}'])
("SSE completed tool arguments reject safely without success or execution: %s", async argumentsText => {
    const prepared = await profile(); let validated = 0;
    const upstream = new Response([start, toolStart, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argumentsText } }, stop, ...terminal].map(frame).join(""));
    const output = await imageAgentClaudeStream(upstream, prepared.privateRules, prepared.input.tools, () => { validated++; }).text();
    expect(output).toContain('"code":"IMAGE_AGENT_ARGUMENTS_INVALID"');
    expect(output).toContain('"repairable":true,"submitted":false');
    expect(output).not.toContain('"type":"message_stop"');
    expect(output).not.toContain('"type":"input_json_delta"');
    expect(validated).toBe(0);
    const outcome = new ChatStreamOutcome(); outcome.push(encoder.encode(output)); expect(outcome.successful).toBe(false);
});

test.each(["frame-json", "frame-duplicate", "eof", "privacy", "network", "abort", "unknown-tool"])
("SSE %s errors never advertise planning repair", async kind => {
    const prepared = await profile();
    let upstream: Response;
    if (kind === "network" || kind === "abort") {
        upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(kind === "abort" ? new DOMException("private upstream abort", "AbortError") : new Error("private upstream network")); } }));
    } else {
        const contents = kind === "frame-json" ? 'event: x\ndata: {"type":\n\n'
            : kind === "frame-duplicate" ? 'event: x\ndata: {"type":"message_start","type":"message_stop"}\n\n'
                : kind === "eof" ? frame(start) + frame(toolStart)
                    : kind === "unknown-tool" ? frame(start) + frame({ ...toolStart, content_block: { ...toolStart.content_block, name: "unknown_tool" } })
                        : [start, toolStart, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"prompt":${JSON.stringify(CANVAS_ASSISTANT_SYSTEM_PROMPT)}` } }, stop].map(frame).join("");
        upstream = new Response(contents);
    }
    const output = await imageAgentClaudeStream(upstream, prepared.privateRules, prepared.input.tools).text();
    expect(output).toContain('"type":"error"');
    expect(output).not.toContain('"repairable"');
    expect(output).not.toContain('"submitted"');
    expect(output).not.toContain('"type":"message_stop"');
    expect(output).not.toContain("private upstream");
    expect(output).not.toContain("你是图片创作助手");
});

test("client cancellation only cancels the original stream", async () => {
    const prepared = await profile(); let cancelled = 0;
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }));
    const output = imageAgentClaudeStream(upstream, prepared.privateRules, prepared.input.tools);
    await output.body!.cancel();
    expect(cancelled).toBe(1);
});
