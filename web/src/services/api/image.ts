import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { requestQueuedImageBatch, requestQueuedImages, type QueuedBatchItem } from "@/services/api/generation-tasks";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

export type ClaudeAssistantContent = Array<Record<string, unknown>>;
export type ResponseInputMessage = AiTextMessage | { type: "claude_assistant"; content: ClaudeAssistantContent } | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string } | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
};

export type ToolResponseResult = { content: string; toolCalls: ResponseToolCall[]; stopReason?: string; claudeAssistantContent?: ClaudeAssistantContent };

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type RequestOptions = { requestId?: string; signal?: AbortSignal; operationType?: "image_generation" | "inpaint" | "upscale" | "batch_image"; tool?: string; webSearch?: boolean; onSubmissionStarted?: () => void; onSubmitted?: (taskIds: string[]) => void | Promise<void> };
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem = { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] } | { type: "claude_assistant"; content: ClaudeAssistantContent } | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string } | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };

const CLAUDE_EMPTY_RESPONSE_RETRY_TOKENS = 8192;

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions, references?: ReferenceImage[]) {
    const count = Number(normalizeImageModelSettings(config, imageModelProfile(config.model || config.imageModel)).count);
    const validation = validateImageReferences(modelOptionName(config.model || config.imageModel), references || []);
    if (!validation.valid) throw new Error(validation.message);
    return requestQueuedImages({
        modelId: modelOptionName(config.model || config.imageModel),
        prompt: withSystemPrompt(config, prompt),
        count,
        operationType: options?.operationType || "image_generation",
        tool: options?.tool,
        parameters: imageTaskParameters(config),
        references,
        requestId: options?.requestId,
        signal: options?.signal,
        onSubmissionStarted: options?.onSubmissionStarted,
        onSubmitted: options?.onSubmitted,
    });
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const profile = imageModelProfile(config.model || config.imageModel);
    if (profile.kind === "midjourney-blend") {
        if (mask) throw new Error("Midjourney Blend 不支持蒙版编辑");
        return requestGeneration(config, "", { ...options, operationType: "image_generation" }, references);
    }
    if (profile.kind === "midjourney") {
        if (mask) throw new Error("当前 Midjourney Imagine 入口不支持蒙版，请使用图像编辑模型");
        return requestGeneration(config, prompt, { ...options, operationType: "image_generation" }, references);
    }
    const validation = validateImageReferences(modelOptionName(config.model || config.imageModel), references);
    if (!validation.valid) throw new Error(validation.message);
    const count = Number(normalizeImageModelSettings(config, profile).count);
    const transparent = profile.kind === "standard" && references.length === 1 && !mask
        && await import("@/lib/image-alpha").then(module => module.imageHasTransparency(references[0]!));
    options?.signal?.throwIfAborted();
    return requestQueuedImages({
        modelId: modelOptionName(config.model || config.imageModel),
        prompt: withSystemPrompt(config, buildImageReferencePromptText(prompt, references)),
        count,
        operationType: options?.operationType || "inpaint",
        tool: options?.tool,
        parameters: { ...imageTaskParameters(config), ...(transparent ? { background: "transparent", output_format: "png" } : {}) },
        references: [...references, ...(mask ? [mask] : [])],
        requestId: options?.requestId,
        signal: options?.signal,
        onSubmissionStarted: options?.onSubmissionStarted,
        onSubmitted: options?.onSubmitted,
    });
}

export function imageTaskParameters(config: AiConfig) {
    const profile = imageModelProfile(config.model || config.imageModel);
    if (!profile.verified) return {};
    const { size, quality } = normalizeImageModelSettings(config, profile);
    if (profile.kind === "standard") return { size, quality };
    if (profile.kind === "midjourney" || profile.kind === "midjourney-blend") return { size, midjourneySpeed: quality };
    return { size, resolution: quality };
}

export async function requestBatchEdit(config: AiConfig, prompt: string, files: Array<{ file: File; title: string }>, options?: { signal?: AbortSignal; onSubmitted?: (batchId: string) => void; onProgress?: (items: QueuedBatchItem[]) => void }) {
    return requestQueuedImageBatch({
        modelId: modelOptionName(config.model || config.imageModel),
        prompt: withSystemPrompt(config, prompt),
        files,
        signal: options?.signal,
        onSubmitted: options?.onSubmitted,
        onProgress: options?.onProgress,
    });
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const input = toResponseInput(withSystemMessage(config, messages));
    const modelId = modelOptionName(config.model || config.textModel);
    let result = await requestServerResponse(config, input, [], "auto", options, onDelta);
    const configuredClaudeMaxTokens = normalizeClaudeMaxTokens(config.claudeMaxTokens);
    if (!result.content.trim() && result.stopReason === "max_tokens" && isClaudeModel(modelId) && configuredClaudeMaxTokens < 16_384) {
        const retryMaxTokens = Math.min(16_384, Math.max(CLAUDE_EMPTY_RESPONSE_RETRY_TOKENS, configuredClaudeMaxTokens * 2));
        result = await requestServerResponse({ ...config, claudeMaxTokens: String(retryMaxTokens) }, input, [], "auto", options, onDelta);
    }
    if (!result.content.trim()) {
        throw new Error(result.stopReason === "max_tokens"
            ? "Claude 已耗尽推理额度但没有生成可见回复，请稍后重试。"
            : "模型没有返回可显示的内容，请重试。",
        );
    }
    const answer = result.content;
    onDelta(answer);
    return answer;
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const result = await requestServerResponse(config, toResponseInput(withSystemMessage(config, messages)), tools.map(toResponseTool), toolChoice, options, onDelta);
    if (result.content) onDelta?.(result.content);
    return result;
}

async function requestServerResponse(config: AiConfig, input: ResponseInputItem[], tools: ResponseApiToolDefinition[], toolChoice: ToolChoice, options?: RequestOptions, onDelta?: (text: string) => void): Promise<ToolResponseResult> {
    const modelId = modelOptionName(config.model || config.textModel);
    const claude = isClaudeModel(modelId)
        ? { stream: config.claudeStream !== "false", thinking: config.claudeThinking === "true", maxTokens: normalizeClaudeMaxTokens(config.claudeMaxTokens) }
        : undefined;
    const response = await fetch("/api/chat/responses", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId, input, tools, toolChoice, webSearch: options?.webSearch === true, ...(claude ? { claude } : {}) }),
        signal: options?.signal,
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || `对话请求失败：${response.status}`);
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) return readClaudeSseResponse(response, onDelta);
    return response.json() as Promise<ToolResponseResult>;
}

export function isClaudeModel(modelId: string) {
    return /^claude-(opus|sonnet|fable)-5$/i.test(modelId.trim()) || modelId.trim().toLowerCase() === "claude-fable-5-1";
}

function normalizeClaudeMaxTokens(value: string | undefined) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.max(256, Math.min(16_384, parsed)) : 2048;
}

export function toolResponseToInput(result: Pick<ToolResponseResult, "toolCalls" | "claudeAssistantContent">): ResponseInputMessage[] {
    if (result.claudeAssistantContent) return [{ type: "claude_assistant", content: result.claudeAssistantContent }];
    return result.toolCalls.map((call) => ({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) }));
}

type ClaudeSseState = { buffer: string; content: string; stopReason?: string; blocks: Map<number, { block: Record<string, unknown>; inputJson: string }> };

export async function readClaudeSseResponse(response: Response, onDelta?: (text: string) => void): Promise<ToolResponseResult> {
    if (!response.body) throw new Error("Claude 流式响应为空");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ClaudeSseState = { buffer: "", content: "", blocks: new Map() };
    while (true) {
        const { done, value } = await reader.read();
        state.buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        state.buffer = state.buffer.replace(/\r\n/g, "\n");
        let boundary = state.buffer.indexOf("\n\n");
        while (boundary >= 0) {
            consumeClaudeSseEvent(state.buffer.slice(0, boundary), state, onDelta);
            state.buffer = state.buffer.slice(boundary + 2);
            boundary = state.buffer.indexOf("\n\n");
        }
        if (done) break;
    }
    if (state.buffer.trim()) consumeClaudeSseEvent(state.buffer, state, onDelta);
    const blocks: ClaudeAssistantContent = Array.from(state.blocks.entries()).sort(([left], [right]) => left - right).map(([, item]) => ({ ...item.block, ...(item.inputJson ? { input: JSON.parse(item.inputJson) as unknown } : {}) }));
    const toolCalls: ResponseToolCall[] = blocks.flatMap((block) => block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" ? [{
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
    }] : []);
    return {
        content: state.content,
        toolCalls,
        ...(toolCalls.length ? { claudeAssistantContent: blocks } : {}),
        ...(state.stopReason ? { stopReason: state.stopReason } : {}),
    };
}

function consumeClaudeSseEvent(event: string, state: ClaudeSseState, onDelta?: (text: string) => void) {
    const raw = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!raw || raw === "[DONE]") return;
    let payload: { type?: string; index?: number; content_block?: Record<string, unknown>; delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null }; error?: { message?: string } };
    try { payload = JSON.parse(raw); } catch { return; }
    const index = payload.index ?? 0;
    if (payload.type === "error") throw new Error(payload.error?.message || "Claude 流式响应失败");
    if (payload.type === "content_block_start") {
        state.blocks.set(index, { block: { ...payload.content_block }, inputJson: "" });
        if (payload.content_block?.type === "text" && typeof payload.content_block.text === "string") {
            state.content += payload.content_block.text;
            onDelta?.(state.content);
        }
        return;
    }
    if (payload.type === "message_delta") {
        if (payload.delta?.stop_reason) state.stopReason = payload.delta.stop_reason;
        return;
    }
    if (payload.type !== "content_block_delta") return;
    const item = state.blocks.get(index);
    if (payload.delta?.text && (payload.delta.type === "text_delta" || !payload.delta.type)) {
        state.content += payload.delta.text;
        if (item) item.block.text = String(item.block.text || "") + payload.delta.text;
        onDelta?.(state.content);
    }
    if (item && payload.delta?.type === "input_json_delta") item.inputJson += payload.delta.partial_json || "";
    if (item && payload.delta?.type === "thinking_delta") item.block.thinking = String(item.block.thinking || "") + (payload.delta.thinking || "");
    if (item && payload.delta?.type === "signature_delta") item.block.signature = String(item.block.signature || "") + (payload.delta.signature || "");
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message && message.type === "claude_assistant") return [{ type: "claude_assistant", content: message.content }];
        if ("type" in message) return [{ type: "function_call", call_id: message.call_id, name: message.name, arguments: message.arguments, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: AiTextMessage["content"]): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return { type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: tool.function.strict };
}
