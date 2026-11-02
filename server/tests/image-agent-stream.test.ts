import { expect, test } from "bun:test";
import { imageAgentClaudeStream } from "../src/image-agent-stream";
import { prepareChatProfileInput, CANVAS_ASSISTANT_SYSTEM_PROMPT } from "../src/prompt-chat-profiles";
import { ChatStreamOutcome } from "../src/chat-billing";

const encoder = new TextEncoder();
const encode = (event: object) => encoder.encode(`event: x\ndata: ${JSON.stringify(event)}\n\n`);
const start = { type: "message_start", message: { id: "msg", role: "assistant" } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const textStop = { type: "content_block_stop", index: 0 };
const terminal = [{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }];
async function profile() { return prepareChatProfileInput({ profile: "canvas-assistant", toolKey: "canvas-chat", tools: [], input: [{ role: "user", content: "把衣领改成V领" }], profileContext: { stage: "plan", currentUserText: "把衣领改成V领", newCreation: false, imageCatalog: [], previewImageIds: [], workNote: "" } }); }
function source(events: object[], split = false) {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events) {
            const bytes = encode(event);
            if (split) for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
            else controller.enqueue(bytes);
        }
        controller.close();
    } }));
}

test("native text is available before provider message_stop, including multibyte chunks", async () => {
    const prepared = await profile();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
    const response = imageAgentClaudeStream(upstream, prepared.privateRules, prepared.input.tools);
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    controller.enqueue(encode(start)); controller.enqueue(encode(textStart));
    controller.enqueue(encode(textDelta("好的，我会把领口改为V领，保持版型、Logo位置和白色背景不变。".repeat(5))));
    let visible = "";
    for (let read = 0; read < 5 && !visible.includes("text_delta"); read++) visible += decoder.decode((await reader.read()).value);
    expect(visible).toContain("text_delta"); expect(visible).not.toContain("message_stop");
    controller.enqueue(encode(textStop)); for (const event of terminal) controller.enqueue(encode(event)); controller.close();
    while (true) { const chunk = await reader.read(); if (chunk.done) break; visible += decoder.decode(chunk.value); }
    expect(visible).toContain("message_stop");
    const split = await imageAgentClaudeStream(source([start, textStart, textDelta("衣领改为V领，保持白底。"), textStop, ...terminal], true), prepared.privateRules, prepared.input.tools).text();
    expect(split).toContain("衣领改为V领，保持白底。");
});

test("tool arguments validate once complete and empty signed thinking is preserved", async () => {
    const prepared = await profile();
    const output = await imageAgentClaudeStream(source([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signed" } }, textStop,
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "edit", name: "edit_image", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"prompt":"衣领' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '改为V领","base":"focus"}' } },
        { type: "content_block_stop", index: 1 }, ...terminal,
    ], true), prepared.privateRules, prepared.input.tools).text();
    expect(output).toContain("opaque-signed"); expect(output).toContain("衣领改为V领");
    expect(output.match(/input_json_delta/g)).toHaveLength(1);
    expect(output).not.toContain('"type":"error"');
    const outcome = new ChatStreamOutcome(); outcome.push(encoder.encode(output));
    expect(outcome.successful).toBe(true);
});

test.each(["text", "tool", "thinking", "upstream-error", "incomplete", "unknown-tool"])("%s failures never expose rules, raw errors or reasoning and never signal success", async channel => {
    const prepared = await profile();
    const events: object[] = [start];
    if (channel === "text") events.push(textStart, ...Array.from(CANVAS_ASSISTANT_SYSTEM_PROMPT).map(textDelta), textStop);
    if (channel === "tool") events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "edit", name: "edit_image", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ prompt: CANVAS_ASSISTANT_SYSTEM_PROMPT }) } }, textStop);
    if (channel === "thinking") events.push({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private reasoning secret" } });
    if (channel === "upstream-error") events.push({ type: "error", error: { message: "upstream echoed private credential", prompt: CANVAS_ASSISTANT_SYSTEM_PROMPT } });
    if (channel === "unknown-tool") events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "delete", name: "canvas_delete_nodes", input: { ids: ["x"] } } });
    if (channel !== "incomplete") events.push(...terminal);
    const output = await imageAgentClaudeStream(source(events), prepared.privateRules, prepared.input.tools).text();
    expect(output).toContain('"type":"error"'); expect(output).not.toContain('"type":"message_stop"');
    for (const secret of ["你是图片创作助手", "private reasoning secret", "upstream echoed private credential"]) expect(output).not.toContain(secret);
    const outcome = new ChatStreamOutcome(); outcome.push(encoder.encode(output)); expect(outcome.successful).toBe(false);
});
