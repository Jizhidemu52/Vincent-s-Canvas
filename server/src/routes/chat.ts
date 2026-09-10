import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { assertModuleEnabled } from "../module-flags";
import { decryptSecret } from "../security";
import type { AuthenticatedRequest } from "../types";

type ResponseContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInput =
    | { role: "system" | "user" | "assistant"; content: string | ResponseContent[] }
    | { type: "claude_assistant"; content: Array<Record<string, unknown>> }
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string };
type ChatCompletionResult = { content: string; toolCalls: ToolCall[]; stopReason?: string; claudeAssistantContent?: Array<Record<string, unknown>> };
type ChatModel = { model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null };

const schema = z.object({
    modelId: z.string().min(1).max(200),
    input: z.array(z.unknown()).max(200),
    tools: z.array(z.unknown()).max(100).default([]),
    toolChoice: z.unknown().optional(),
    webSearch: z.boolean().optional(),
    gemini: z.object({ maxOutputTokens: z.number().int().min(1).max(16384) }).optional(),
    claude: z.object({
        stream: z.boolean().optional(),
        thinking: z.boolean().optional(),
        maxTokens: z.number().int().min(1).max(16384).optional(),
    }).optional(),
});

export function createChatRouter(db: Database, config: AppConfig) {
    const router = Router();

    router.post("/responses", async (request, response, next) => {
        try {
            const input = schema.parse(request.body) as {
                modelId: string;
                input: ResponseInput[];
                tools: ResponseTool[];
                toolChoice?: unknown;
                webSearch?: boolean;
                gemini?: { maxOutputTokens: number };
                claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number };
            };
            await assertModuleEnabled(db, "gpt-chat");

            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query<ChatModel>(
                `SELECT m.model_id,p.base_url,p.protocol,p.encrypted_credentials
                 FROM model_configs m JOIN providers p ON p.id=m.provider_id
                 WHERE (m.id::text=$1 OR m.model_id=$1)
                   AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities)
                 LIMIT 1`,
                [input.modelId],
            );
            const model = result.rows[0];
            if (!model) {
                response.status(400).json({ error: "MODEL_DISABLED", message: "管理员尚未启用该对话模型" });
                return;
            }
            if (!model.encrypted_credentials || !config.PROVIDER_ENCRYPTION_KEY) {
                response.status(503).json({ error: "PROVIDER_NOT_CONFIGURED", message: "对话模型服务端凭据未配置" });
                return;
            }

            const credentials = JSON.parse(decryptSecret(model.encrypted_credentials, config.PROVIDER_ENCRYPTION_KEY)) as Record<string, string>;
            if (model.protocol === "anthropic" && input.claude?.stream) {
                const upstream = await requestClaudeStream(model, credentials, input);
                response.setHeader("content-type", "text/event-stream; charset=utf-8");
                response.setHeader("cache-control", "no-cache");
                for await (const chunk of upstream.body!) {
                    if (response.destroyed) break;
                    response.write(chunk);
                }
                if (!response.destroyed) await writeAudit(db, {
                    actor,
                    action: "chat.completed",
                    targetType: "model",
                    targetId: input.modelId,
                    result: "success",
                    detail: { protocol: model.protocol, streaming: true },
                    ip: request.ip,
                });
                response.end();
                return;
            }
            const resultPayload = await requestChatCompletion(model, credentials, input);

            await writeAudit(db, {
                actor,
                action: "chat.completed",
                targetType: "model",
                targetId: input.modelId,
                result: "success",
                detail: { protocol: model.protocol, toolCallCount: resultPayload.toolCalls.length },
                ip: request.ip,
            });
            response.json(resultPayload);
        } catch (error) {
            if (response.headersSent) {
                if (!response.destroyed) response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "对话流已中断，请重试。" } })}\n\n`);
                return;
            }
            next(error);
        }
    });

    return router;
}

export async function requestChatCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number }; claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number } },
): Promise<ChatCompletionResult> {
    if (model.protocol === "gemini") return requestGeminiCompletion(model, credentials, input);
    if (model.protocol === "anthropic") return requestClaudeCompletion(model, credentials, input);
    if (model.protocol === "openai-chat") return requestOpenAiChatCompletion(model, credentials, input);
    if (model.protocol === "openai" || model.protocol === "custom") return requestOpenAiCompletion(model, credentials, input);
    throw new ChatProtocolError("PROTOCOL_NOT_SUPPORTED", "当前对话入口暂不支持该 Provider 协议");
}

async function requestClaudeCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number } },
) {
    const upstream = await fetch(claudeMessagesUrl(model.base_url), {
        method: "POST",
        headers: claudeHeaders(credentials),
        body: JSON.stringify({ model: model.model_id, ...buildClaudeMessagesRequest(input, { modelId: model.model_id, maxTokens: input.claude?.maxTokens || 2048, thinking: input.claude?.thinking }) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Claude Provider", upstream);
    return readClaudeResponse(await upstream.json() as ClaudeResponse);
}

export async function requestClaudeStream(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; claude?: { thinking?: boolean; maxTokens?: number } },
) {
    const upstream = await fetch(claudeMessagesUrl(model.base_url), {
        method: "POST",
        headers: claudeHeaders(credentials),
        body: JSON.stringify({ model: model.model_id, ...buildClaudeMessagesRequest(input, { modelId: model.model_id, maxTokens: input.claude?.maxTokens || 2048, thinking: input.claude?.thinking, stream: true }) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Claude Provider", upstream);
    if (!upstream.body) throw new ChatProtocolError("CLAUDE_STREAM_EMPTY", "Claude 流式响应为空");
    return upstream;
}

function claudeMessagesUrl(baseUrl: string) {
    return `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/messages`;
}

function claudeHeaders(credentials: Record<string, string>) {
    const headers = requestHeaders(credentials);
    // OpenToken documents Bearer auth; retain x-api-key for existing native providers.
    if (credentials.apiKey) headers.set("x-api-key", credentials.apiKey);
    headers.set("anthropic-version", ANTHROPIC_MESSAGES_VERSION);
    return headers;
}

export function buildClaudeMessagesRequest(
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown },
    options: { modelId?: string; maxTokens: number; stream?: boolean; thinking?: boolean },
) {
    const system = input.input
        .flatMap((item) => {
            if (!("role" in item) || item.role !== "system") return [];
            if (typeof item.content !== "string") throw new ChatProtocolError("CLAUDE_SYSTEM_FORMAT_NOT_SUPPORTED", "Claude system prompt only supports text content");
            return [item.content];
        })
        .filter(Boolean)
        .join("\n\n");
    const calls = new Map<string, string>();
    const messages: Array<Record<string, unknown>> = [];
    for (const item of input.input) {
        if ("role" in item) {
            if (item.role !== "system") messages.push({ role: item.role, content: toClaudeContent(item.content) });
            continue;
        }
        if (item.type === "claude_assistant") {
            // Tool continuations must echo the complete assistant turn, preserving
            // thinking/signature blocks and their order without reconstructing them.
            for (const block of item.content) {
                if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") calls.set(block.id, block.name);
            }
            messages.push({ role: "assistant", content: item.content });
            continue;
        }
        if (item.type === "function_call") {
            calls.set(item.call_id, item.name);
            messages.push({ role: "assistant", content: [{ type: "tool_use", id: item.call_id, name: item.name, input: parseJsonObject(item.arguments) }] });
            continue;
        }
        const name = calls.get(item.call_id);
        if (name) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }] });
    }
    const tools = input.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.parameters,
    }));
    return {
        ...(system ? { system } : {}),
        messages,
        max_tokens: Math.max(1, Math.floor(options.maxTokens || 2048)),
        ...(tools.length ? { tools, tool_choice: toClaudeToolChoice(input.toolChoice) } : {}),
        ...(options.stream ? { stream: true } : {}),
        ...claudeThinkingParameters(options),
    };
}

function claudeThinkingParameters(options: { modelId?: string; maxTokens: number; thinking?: boolean }) {
    // OpenToken does not document a thinking override for this alias. Use its
    // default instead of guessing Claude 5 or legacy budget semantics.
    if (options.modelId?.toLowerCase() === "claude-fable-5-1") return {};
    // ApiMart delegates parameter semantics to Anthropic. Claude 5 rejects the
    // legacy enabled/budget_tokens setting; Fable 5 also rejects disabled.
    if (/^claude-(opus|sonnet|fable)-5$/i.test(options.modelId || "")) {
        const alwaysOn = options.modelId?.toLowerCase() === "claude-fable-5";
        return { thinking: alwaysOn || options.thinking !== false ? { type: "adaptive", display: "omitted" } : { type: "disabled" } };
    }
    if (!options.thinking) return {};
    if (options.maxTokens <= 1024) throw new ChatProtocolError("CLAUDE_THINKING_BUDGET_INVALID", "手动思考预算为 1024 时，总输出预算必须大于 1024");
    return { thinking: { type: "enabled", budget_tokens: 1024 } };
}

export function readClaudeResponse(body: ClaudeResponse): ChatCompletionResult {
    const hasTools = (body.content || []).some((block) => block.type === "tool_use");
    return {
        content: (body.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join(""),
        toolCalls: (body.content || []).flatMap((block) => block.type === "tool_use" && block.name ? [{
            id: block.id || crypto.randomUUID(),
            type: "function" as const,
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        }] : []),
        ...(hasTools ? { claudeAssistantContent: body.content } : {}),
        ...(body.stop_reason ? { stopReason: body.stop_reason } : {}),
    };
}

function toClaudeContent(content: string | ResponseContent[]) {
    if (typeof content === "string") return content;
    return content.map((part) => {
        if (part.type === "input_text") return { type: "text", text: part.text };
        const dataUrl = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(part.image_url);
        if (!dataUrl) throw new ChatProtocolError("CLAUDE_IMAGE_FORMAT_NOT_SUPPORTED", "Claude 原生对话仅支持 data URL 图片；请先上传为可用的内联图片。");
        return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
    });
}

function toClaudeToolChoice(value: unknown) {
    if (value === "required") return { type: "any" };
    if (value && typeof value === "object" && "type" in value && (value as { type?: unknown }).type === "function") {
        const name = (value as { name?: unknown }).name;
        return typeof name === "string" ? { type: "tool", name } : { type: "auto" };
    }
    return { type: "auto" };
}

async function requestOpenAiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean },
) {
    const upstream = await fetch(`${model.base_url.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({
            model: model.model_id,
            input: input.input,
            tools: input.tools,
            tool_choice: input.toolChoice ?? "auto",
            parallel_tool_calls: false,
        }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("对话 Provider", upstream);

    const body = await upstream.json() as {
        output_text?: string;
        output?: Array<{ type?: string; content?: Array<{ text?: string }>; id?: string; call_id?: string; name?: string; arguments?: string; thoughtSignature?: string }>;
    };
    const content = body.output_text
        || body.output?.flatMap((item) => item.type === "message" ? item.content || [] : []).map((item) => item.text || "").join("")
        || "";
    const toolCalls = (body.output || [])
        .filter((item) => item.type === "function_call" && item.name)
        .map((item) => ({
            id: item.call_id || item.id || crypto.randomUUID(),
            type: "function" as const,
            function: { name: item.name!, arguments: item.arguments || "{}" },
            ...(item.thoughtSignature ? { thoughtSignature: item.thoughtSignature } : {}),
        }));
    return { content, toolCalls };
}

async function requestOpenAiChatCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown },
): Promise<ChatCompletionResult> {
    type Message = { role: string; content: unknown; tool_calls?: ToolCall[]; tool_call_id?: string };
    const messages: Message[] = [];
    for (const item of input.input) {
        if ("role" in item) {
            messages.push({ role: item.role, content: typeof item.content === "string" ? item.content : item.content.map(part =>
                part.type === "input_text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.image_url } },
            ) });
        } else if (item.type === "function_call") {
            const call: ToolCall = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } };
            const previous = messages.at(-1);
            if (previous?.role === "assistant" && previous.tool_calls) previous.tool_calls.push(call);
            else messages.push({ role: "assistant", content: null, tool_calls: [call] });
        } else if (item.type === "function_call_output") {
            messages.push({ role: "tool", content: item.output, tool_call_id: item.call_id });
        } else {
            throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "该会话包含 Claude 原生工具记录，请新建对话后切换接口协议。");
        }
    }
    const toolChoice = input.toolChoice && typeof input.toolChoice === "object" && "name" in input.toolChoice
        ? { type: "function", function: { name: input.toolChoice.name } } : input.toolChoice ?? "auto";
    const upstream = await fetch(`${model.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({
            model: model.model_id,
            messages,
            ...(input.tools.length ? {
                tools: input.tools.map(({ type, ...definition }) => ({ type, function: definition })),
                tool_choice: toolChoice,
                parallel_tool_calls: false,
            } : {}),
        }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Chat Completions Provider", upstream);
    const body = await upstream.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }> };
    const choice = body.choices?.[0];
    return { content: choice?.message?.content || "", toolCalls: choice?.message?.tool_calls || [], ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}) };
}

async function requestGeminiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number } },
) {
    const upstream = await fetch(buildGeminiGenerateUrl(model.base_url, model.model_id), {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify(buildGeminiRequestBody(input)),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Gemini Provider", upstream);

    return readGeminiResponse(await upstream.json() as GeminiResponse);
}

export function buildGeminiGenerateUrl(baseUrl: string, modelId: string) {
    const root = baseUrl.replace(/\/$/, "").replace(/\/v1(?:beta)?$/, "");
    return `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
}

export function toGeminiContents(input: ResponseInput[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
    const calls = new Map<string, { name: string }>();
    return input.flatMap((item) => {
        if ("type" in item && item.type === "function_call_output") {
            const call = calls.get(item.call_id);
            return call ? [{ role: "user", parts: [{ functionResponse: { name: call.name, response: parseJsonObject(item.output, "result") } }] }] : [];
        }
        if ("role" in item) {
            return [{ role: item.role === "assistant" ? "model" : "user", parts: toGeminiParts(item.content) as Array<Record<string, unknown>> }];
        }
        if (item.type === "function_call") {
            calls.set(item.call_id, { name: item.name });
            return [{
                role: "model",
                parts: [{
                    functionCall: { name: item.name, args: parseJsonObject(item.arguments) },
                    ...(item.thoughtSignature ? { thoughtSignature: item.thoughtSignature } : {}),
                }],
            }];
        }
        return [];
    });
}

export function buildGeminiRequestBody(input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number } }) {
    const maxOutputTokens = input.gemini?.maxOutputTokens;
    if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384)) {
        throw new ChatProtocolError("INVALID_GEMINI_MAX_OUTPUT_TOKENS", "Gemini 输出 token 上限必须是 1–16384 的整数");
    }
    const declarations = input.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        // OpenAI tools use JSON Schema (including additionalProperties), not Gemini's OpenAPI subset.
        parametersJsonSchema: tool.parameters,
    }));
    const tools = [
        ...(declarations.length ? [{ functionDeclarations: declarations }] : []),
        ...(input.webSearch ? [{ googleSearch: {} }] : []),
    ];
    return {
        contents: toGeminiContents(input.input),
        ...(maxOutputTokens !== undefined ? { generationConfig: { maxOutputTokens } } : {}),
        ...(tools.length ? {
            tools,
            ...(declarations.length ? {
            toolConfig: { functionCallingConfig: { mode: input.toolChoice === "required" ? "ANY" : "AUTO" } },
            } : {}),
        } : {}),
    };
}

export function readGeminiResponse(body: GeminiResponse): { content: string; toolCalls: ToolCall[] } {
    const candidates = body.data?.candidates || body.candidates || [];
    const parts = candidates.flatMap((candidate) => candidate.content?.parts || []);
    return {
        content: withGroundingSources(parts.map((part) => part.text || "").join(""), candidates),
        toolCalls: parts.flatMap((part) => part.functionCall?.name ? [{
            id: crypto.randomUUID(), type: "function" as const,
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        }] : []),
    };
}

function withGroundingSources(content: string, candidates: GeminiCandidate[]) {
    if (!content.trim()) return content;
    const sources = Array.from(new Map(
        candidates.flatMap((candidate) => candidate.groundingMetadata?.groundingChunks || [])
            .flatMap((chunk) => chunk.web?.uri ? [[chunk.web.uri, chunk.web.title || chunk.web.uri] as const] : []),
    ).entries()).slice(0, 5);
    if (!sources.length) return content;
    return `${content}\n\n联网参考：\n${sources.map(([uri, title]) => `- ${title}: ${uri}`).join("\n")}`;
}

function parseJsonObject(value: string, fallbackKey?: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Plain text tool output is wrapped below. */ }
    return fallbackKey ? { [fallbackKey]: value } : {};
}

function toGeminiParts(content: string | ResponseContent[]) {
    if (typeof content === "string") return [{ text: content }];
    return content.map((part) => {
        if (part.type === "input_text") return { text: part.text };
        const dataUrl = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec(part.image_url);
        if (!dataUrl) {
            throw new ChatProtocolError("GEMINI_IMAGE_FORMAT_NOT_SUPPORTED", "Gemini 原生对话仅支持 data URL 图片；请先将图片上传为可用的内联图片。");
        }
        return { inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } };
    });
}

function requestHeaders(credentials: Record<string, string>) {
    const headers = new Headers({ "content-type": "application/json" });
    if (credentials.apiKey) headers.set("authorization", `Bearer ${credentials.apiKey}`);
    return headers;
}

async function upstreamError(label: string, upstream: Response) {
    const detail = (await upstream.text()).slice(0, 500);
    return new ChatProtocolError("UPSTREAM_REQUEST_FAILED", `${label} ${upstream.status}: ${detail}`);
}

export class ChatProtocolError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

type GeminiResponse = {
    data?: { candidates?: GeminiCandidate[] };
    candidates?: GeminiCandidate[];
};
type GeminiCandidate = {
    content?: { parts?: Array<{ text?: string; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
};

type ClaudeResponse = {
    stop_reason?: string;
    content?: Array<{
        [key: string]: unknown;
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
    }>;
};
export const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";
