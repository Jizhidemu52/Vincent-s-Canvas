import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
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

export type ResponseInputMessage = AiTextMessage | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string } | { role: "tool"; tool_call_id: string; content: string };

export type ResponseFunctionTool = {
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
};

export type ToolResponseResult = { content: string; toolCalls: ResponseToolCall[] };

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type RequestOptions = { signal?: AbortSignal; operationType?: "image_generation" | "inpaint" | "upscale" | "batch_image"; tool?: string };
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem = { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] } | { type: "function_call"; call_id: string; name: string; arguments: string } | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions, references?: ReferenceImage[]) {
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    return requestQueuedImages({
        modelId: modelOptionName(config.model || config.imageModel),
        prompt: withSystemPrompt(config, prompt),
        count,
        operationType: options?.operationType || "image_generation",
        tool: options?.tool,
        parameters: imageTaskParameters(config),
        references,
        signal: options?.signal,
    });
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    return requestQueuedImages({
        modelId: modelOptionName(config.model || config.imageModel),
        prompt: withSystemPrompt(config, buildImageReferencePromptText(prompt, references)),
        count,
        operationType: options?.operationType || "inpaint",
        tool: options?.tool,
        parameters: imageTaskParameters(config),
        references: [...references, ...(mask ? [mask] : [])],
        signal: options?.signal,
    });
}

export function imageTaskParameters(config: AiConfig) {
    const value = String(config.size || "1:1").toLowerCase();
    const configuredResolution = String(config.quality || "").toLowerCase();
    const resolution = configuredResolution === "0.5k" || configuredResolution === "1k" || configuredResolution === "2k" || configuredResolution === "4k"
        ? configuredResolution
        : value.includes("4k") || /(^|x)3840x2160$|^2160x3840$/.test(value) ? "4k" : value.includes("2k") || /^2048x/.test(value) || /x2048$/.test(value) ? "2k" : "1k";
    const size =
        value.includes("16:9") || /^1824x1024$|^2048x1152$|^3840x2160$/.test(value)
            ? "16:9"
            : value.includes("9:16") || /^1024x1824$|^1152x2048$|^2160x3840$/.test(value)
              ? "9:16"
              : value.includes("3:2") || /^1536x1024$/.test(value)
                ? "3:2"
                : value.includes("2:3") || /^1024x1536$/.test(value)
                  ? "2:3"
                  : value.includes("4:3") || /^1360x1024$/.test(value)
                    ? "4:3"
                    : value.includes("3:4") || /^1024x1360$/.test(value)
                      ? "3:4"
                      : "1:1";
    return { size, resolution };
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
    const result = await requestServerResponse(config, toResponseInput(withSystemMessage(config, messages)), [], "auto", options);
    const answer = result.content || "没有返回内容";
    onDelta(answer);
    return answer;
}

export async function requestToolResponse(config: AiConfig, messages: ResponseInputMessage[], tools: ResponseFunctionTool[], toolChoice: ToolChoice = "auto", onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const result = await requestServerResponse(config, toResponseInput(withSystemMessage(config, messages)), tools.map(toResponseTool), toolChoice, options);
    if (result.content) onDelta?.(result.content);
    return result;
}

async function requestServerResponse(config: AiConfig, input: ResponseInputItem[], tools: ResponseApiToolDefinition[], toolChoice: ToolChoice, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch("/api/chat/responses", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: modelOptionName(config.model || config.textModel), input, tools, toolChoice }),
        signal: options?.signal,
    });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || `对话请求失败：${response.status}`);
    }
    return response.json() as Promise<ToolResponseResult>;
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
        if ("type" in message) return [{ type: "function_call", call_id: message.call_id, name: message.name, arguments: message.arguments }];
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
