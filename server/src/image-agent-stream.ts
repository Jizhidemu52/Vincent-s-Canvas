import { parseStrictJson } from "./strict-json";
import { assertProfileRuleSafety, validateChatProfileOutput } from "./prompt-chat-profiles";
import { PromptOptimizationError } from "./prompt-safety";
import type { ChatCompletionResult, ResponseTool } from "./routes/chat";

type Block = { value: Record<string, unknown>; json: string; sent: number; stopped: boolean };
const invalid = () => new PromptOptimizationError("CHAT_STREAM_INVALID", "对话流格式无效，本轮未完成，不会自动重新提交。", 502);

/** Keep enough normalized text to check a complete private-rule fragment before forwarding it. */
function textSafeEnd(text: string) {
    let remaining = 96, index = text.length;
    while (index > 0 && remaining > 0) {
        const code = text.codePointAt(index - 1)!;
        const width = code >= 0xdc00 && code <= 0xdfff && index > 1 ? 2 : 1;
        const part = text.slice(index - width, index).normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
        remaining -= part.length;
        index -= width;
    }
    return index;
}

/** Native SSE remains live; tool arguments are emitted only after complete validation. */
export function imageAgentClaudeStream(upstream: Response, rules: readonly string[], tools: readonly ResponseTool[], onValidated?: (result: ChatCompletionResult) => void | Promise<void>) {
    if (!upstream.body) throw invalid();
    const reader = upstream.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    const blocks = new Map<number, Block>();
    let pending = "", content = "", stopReason: string | undefined, stopped = false, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (event: Record<string, unknown>) => {
                assertProfileRuleSafety(event, rules);
                controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            };
            const text = (index: number, block: Block, final = false) => {
                const value = String(block.value.text || "");
                assertProfileRuleSafety(content, rules);
                const end = final ? value.length : textSafeEnd(value);
                if (end > block.sent) {
                    send({ type: "content_block_delta", index, delta: { type: "text_delta", text: value.slice(block.sent, end) } });
                    block.sent = end;
                }
            };
            const consume = async (source: string) => {
                const raw = source.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                if (!raw) return;
                const event = parseStrictJson(raw) as Record<string, any>;
                if (!event || typeof event !== "object" || Array.isArray(event)) throw invalid();
                if (event.type === "error") throw invalid();
                if (event.type === "message_start") { send({ type: "message_start", message: { role: "assistant", content: [] } }); return; }
                if (event.type === "ping") { send({ type: "ping" }); return; }
                if (event.type === "message_delta") {
                    stopReason = event.delta?.stop_reason;
                    if (stopReason !== null && stopReason !== undefined && !["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal"].includes(stopReason)) throw invalid();
                    send({ type: "message_delta", delta: { stop_reason: stopReason } }); return;
                }
                if (event.type === "message_stop") {
                    if ([...blocks.values()].some(block => !block.stopped)) throw invalid();
                    const values = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.value);
                    const result: ChatCompletionResult = { content, toolCalls: values.flatMap(block => block.type === "tool_use" ? [{ id: String(block.id), type: "function" as const, function: { name: String(block.name), arguments: JSON.stringify(block.input) } }] : []),
                        ...(stopReason ? { stopReason } : {}), ...(values.some(block => block.type === "tool_use") ? { claudeAssistantContent: values } : {}) };
                    if (!content.trim() && !result.toolCalls.length) throw invalid();
                    const validated = validateChatProfileOutput(result, rules);
                    await onValidated?.(validated);
                    stopped = true;
                    send({ type: "message_stop" });
                    return;
                }
                const index = event.index;
                if (!Number.isInteger(index) || index < 0 || index > 100) throw invalid();
                if (event.type === "content_block_start") {
                    if (blocks.has(index)) throw invalid();
                    const value = event.content_block;
                    if (!value || typeof value !== "object") throw invalid();
                    let safe: Record<string, unknown>;
                    if (value.type === "text") safe = { type: "text", text: String(value.text || "") };
                    else if (value.type === "tool_use") {
                        if (!tools.some(tool => tool.name === value.name) || typeof value.id !== "string") throw invalid();
                        safe = { type: "tool_use", id: value.id, name: value.name, input: value.input || {} };
                    } else if (value.type === "thinking") {
                        if (value.thinking) throw new PromptOptimizationError("CHAT_PRIVATE_THINKING_UNSUPPORTED", "该模型未隐藏思考，本轮已停止，请管理员检查模型配置。", 422);
                        safe = { type: "thinking", thinking: "", ...(typeof value.signature === "string" ? { signature: value.signature } : {}) };
                    } else if (value.type === "redacted_thinking" && typeof value.data === "string") safe = { type: "redacted_thinking", data: value.data };
                    else throw invalid();
                    const block = { value: safe, json: "", sent: 0, stopped: false };
                    blocks.set(index, block);
                    send({ type: "content_block_start", index, content_block: safe.type === "text" ? { type: "text", text: "" } : safe.type === "tool_use" ? { ...safe, input: {} } : safe });
                    if (safe.type === "text") { content += String(safe.text); text(index, block); }
                    return;
                }
                const block = blocks.get(index);
                if (!block || block.stopped) throw invalid();
                if (event.type === "content_block_delta") {
                    const delta = event.delta;
                    if (delta?.type === "text_delta" && block.value.type === "text" && typeof delta.text === "string") {
                        block.value.text = String(block.value.text) + delta.text; content += delta.text;
                        if (content.length > 100_000) throw invalid();
                        text(index, block);
                    } else if (delta?.type === "input_json_delta" && block.value.type === "tool_use" && typeof delta.partial_json === "string") {
                        block.json += delta.partial_json;
                        if (block.json.length > 100_000) throw invalid();
                    } else if (delta?.type === "signature_delta" && block.value.type === "thinking" && typeof delta.signature === "string") {
                        block.value.signature = String(block.value.signature || "") + delta.signature;
                        assertProfileRuleSafety(block.value, rules);
                        send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: delta.signature } });
                    } else if (delta?.type === "thinking_delta" && block.value.type === "thinking" && !delta.thinking) { /* Omitted thinking only. */ }
                    else throw invalid();
                    return;
                }
                if (event.type !== "content_block_stop") throw invalid();
                if (block.value.type === "text") text(index, block, true);
                if (block.value.type === "tool_use") {
                    const args = block.json ? parseStrictJson(block.json) : block.value.input;
                    const single: ChatCompletionResult = { content: "", toolCalls: [{ id: String(block.value.id), type: "function", function: { name: String(block.value.name), arguments: JSON.stringify(args) } }] };
                    validateChatProfileOutput(single, rules);
                    block.value.input = args;
                    send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } });
                }
                block.stopped = true;
                send({ type: "content_block_stop", index });
            };
            try {
                while (!stopped && !cancelled) {
                    const chunk = await reader.read();
                    pending += decoder.decode(chunk.value, { stream: !chunk.done });
                    if (pending.length > 1_000_000) throw invalid();
                    let boundary: RegExpExecArray | null;
                    while (!stopped && (boundary = /\r?\n\r?\n/.exec(pending))) {
                        const event = pending.slice(0, boundary.index);
                        pending = pending.slice(boundary.index + boundary[0].length);
                        await consume(event);
                    }
                    if (chunk.done) break;
                }
                if (!stopped && !cancelled) throw invalid();
            } catch (error) {
                if (!cancelled) send({ type: "error", error: { code: error instanceof PromptOptimizationError ? error.code : "CHAT_STREAM_INTERRUPTED", message: error instanceof PromptOptimizationError ? error.message : "对话流已中断，本轮未完成，不会自动重新提交。" } });
            } finally {
                try { await reader.cancel(); } catch { /* Do not replace the actual outcome. */ }
                reader.releaseLock();
                if (!cancelled) controller.close();
            }
        },
        async cancel() { cancelled = true; await reader.cancel().catch(() => {}); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
}
