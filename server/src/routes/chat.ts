import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { resolveToolExecution } from "../tool-configuration";
import { decryptSecret } from "../security";
import { fetchProviderSubmission, readProviderSubmissionDiagnostics } from "../provider-submission-transport";
import type { AuthenticatedRequest } from "../types";
import { beginUsageChat, finishUsageChat } from "../usage-analytics";
import { beginChatBilling, ChatStreamOutcome, finishChatBilling } from "../chat-billing";
import { getCreditsEnabled } from "../credit-policy";
import { deploymentFeatures } from "../deployment-features";
import { DuplicateJsonKeyError, parseStrictJson } from "../strict-json";
import { chatPromptProfiles, prepareChatProfileInput, validateChatProfileOutput, type ChatPromptProfile } from "../prompt-chat-profiles";
import { PromptOptimizationError } from "../prompt-safety";

type ResponseContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
export type ResponseInput =
    | { role: "system" | "user" | "assistant"; content: string | ResponseContent[] }
    | { type: "claude_assistant"; content: Array<Record<string, unknown>> }
    | { type: "responses_assistant"; output: Array<Record<string, unknown>> }
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { type: "function_call_output"; call_id: string; output: string };
export type ResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string };
export type ChatCompletionUsage = { inputTokens?: number; outputTokens?: number; actualCost?: number; currency?: string };
export type ChatCompletionResult = { content: string; toolCalls: ToolCall[]; stopReason?: string; claudeAssistantContent?: Array<Record<string, unknown>>; responsesOutputItems?: Array<Record<string, unknown>>; usage?: ChatCompletionUsage };
export type ChatCompletionInput = { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number }; claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number }; privateProfile?: boolean };
type ChatModel = { model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null };
/** Shared by explicit administrator analysis selection and the execution adapter. */
export const CHAT_COMPLETION_PROTOCOLS = ["openai", "custom", "apimart", "gemini", "anthropic", "openai-chat"] as const;

export function isClaudeMessagesModel(model: Pick<ChatModel, "protocol" | "model_id">) {
    return model.protocol === "anthropic" || (model.protocol === "apimart" && model.model_id === "claude-sonnet-5-5");
}

// This endpoint returns client-side function plans only. Hosted tools (notably
// image_generation) must not bypass authorized image tasks and their billing.
export const chatFunctionToolsSchema = z.array(z.object({
    type: z.literal("function"),
    name: z.string().min(1).max(200),
    description: z.string().max(20_000).optional(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
}).strict()).max(100).default([]);

const schema = z.object({
    // createClientId also supports non-secure LAN HTTP where randomUUID is absent.
    requestId: z.string().min(8).max(160).regex(/^[a-zA-Z0-9:_-]+$/).optional(),
    modelId: z.string().min(1).max(200).optional(),
    toolKey: z.string().min(1).max(100).optional(),
    profile: z.enum(chatPromptProfiles).optional(),
    profileContext: z.record(z.string(), z.unknown()).optional(),
    input: z.array(z.unknown()).max(200),
    tools: chatFunctionToolsSchema,
    toolChoice: z.unknown().optional(),
    webSearch: z.boolean().optional(),
    gemini: z.object({ maxOutputTokens: z.number().int().min(1).max(16384) }).optional(),
    claude: z.object({
        stream: z.boolean().optional(),
        thinking: z.boolean().optional(),
        maxTokens: z.number().int().min(1).max(16384).optional(),
    }).optional(),
});

const CHAT_REQUEST_TIMEOUT_MESSAGE = "对话模型请求在 180 秒内未完成，已超时；本轮对话未完成，不会自动重新提交。";

/** Inspect only typed metadata, never messages; bounded traversal tolerates cyclic causes. */
function chatErrorMetadata(error: unknown) {
    const metadata = { code: "UNCLASSIFIED_ERROR", name: "UnknownError", timeout: false };
    const seen = new Set<object>();
    try {
        for (let depth = 0; depth < 8 && error && typeof error === "object" && !seen.has(error); depth++) {
            seen.add(error);
            const record = error as Record<string, unknown>;
            if (record.name === "TimeoutError") return { code: "CHAT_REQUEST_TIMEOUT", name: "TimeoutError", timeout: true };
            if (depth === 0) {
                if (error instanceof ChatProtocolError) metadata.name = "ChatProtocolError";
                else if (typeof record.name === "string" && ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "AggregateError", "ZodError"].includes(record.name)) metadata.name = record.name;
            }
            if (metadata.code === "UNCLASSIFIED_ERROR" && typeof record.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(record.code)) metadata.code = record.code;
            error = record.cause;
        }
    } catch { /* Malformed diagnostic properties must not replace the original error. */ }
    return metadata;
}

export type ChatRouterOptions = {
    loadProfileRules?: (profile: ChatPromptProfile, actor: AuthenticatedRequest["auth"]) => Promise<string>;
    validateProfileOutput?: (result: ChatCompletionResult, privateRules: readonly string[]) => void | Promise<void>;
};

export function createChatRouter(db: Database, config: AppConfig, options: ChatRouterOptions = {}) {
    const router = Router();
    const features = deploymentFeatures(config);

    router.post("/responses", async (request, response, next) => {
        const startedAt = performance.now();
        let usageRequestId: string | undefined;
        let billingReservationId: string | null = null;
        let providerInFlight = false;
        const socket = request.socket;
        const hadRemoteAddress = Boolean(socket?.remoteAddress);
        // Bun 1.3.x can lose its native socket without setting destroyed or
        // emitting ServerResponse.close. Its public peer address then disappears.
        const disconnected = () => Boolean(response.destroyed || request.aborted || socket?.destroyed
            || (hadRemoteAddress && !socket.remoteAddress));
        try {
            const parsed = schema.parse(request.body) as {
                requestId?: string;
                modelId?: string;
                toolKey?: string;
                profile?: ChatPromptProfile;
                profileContext?: Record<string, unknown>;
                input: ResponseInput[];
                tools: ResponseTool[];
                toolChoice?: unknown;
                webSearch?: boolean;
                gemini?: { maxOutputTokens: number };
                claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number };
            };
            const actor = (request as unknown as AuthenticatedRequest).auth;
            const prepared = await prepareChatProfileInput(parsed, options.loadProfileRules ? profile => options.loadProfileRules!(profile, actor) : undefined);
            const input = prepared.input;
            const execution = await resolveToolExecution(db, { ...input, operationType: "chat" });
            const result = await db.query<ChatModel>(
                `SELECT m.model_id,p.base_url,p.protocol,p.encrypted_credentials
                 FROM model_configs m JOIN providers p ON p.id=m.provider_id
                 WHERE m.id=$1
                   AND m.enabled=true AND p.enabled=true AND 'chat'=ANY(m.capabilities)
                 LIMIT 1`,
                [execution.modelConfigId],
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
            billingReservationId = await beginChatBilling(db, {
                requestId: input.requestId, userId: actor.id,
                anonymous: (request as AuthenticatedRequest).allowsAnonymousCreation,
                enabled: features.authenticationEnabled && await getCreditsEnabled(db, features.creditsEnabled), execution,
            });
            if (disconnected()) throw new ChatProtocolError("CHAT_REQUEST_CANCELLED", "对话请求已中断，本次不扣积分");
            if (features.authenticationEnabled && !(request as AuthenticatedRequest).allowsAnonymousCreation) {
                // Runtime rules never enter chat history/usage previews.
                usageRequestId = await beginUsageChat(db, { userId: actor.id, modelConfigId: execution.modelConfigId, boardKey: execution.toolKey, input: parsed.input });
            }
            providerInFlight = true;
            if (isClaudeMessagesModel(model) && input.claude?.stream) {
                const upstream = await requestClaudeStream(model, credentials, input);
                response.setHeader("content-type", "text/event-stream; charset=utf-8");
                response.setHeader("cache-control", "no-cache");
                const streamOutcome = new ChatStreamOutcome();
                const reader = upstream.body!.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done || disconnected()) break;
                        streamOutcome.push(value);
                        response.write(value);
                        // Forward the complete terminal event before ending an
                        // upstream HTTP stream that may otherwise remain open.
                        if (streamOutcome.terminal) break;
                    }
                } finally {
                    // Cleanup failure cannot invalidate a completed reply or
                    // replace the actual read failure; never replay this request.
                    try { await reader.cancel(); } catch { /* Best-effort cleanup only. */ }
                    reader.releaseLock();
                }
                if (!disconnected() && !streamOutcome.successful) throw new ChatProtocolError("CHAT_STREAM_INCOMPLETE", "对话流未完整返回有效回复，本次不扣积分");
                providerInFlight = false;
                if (usageRequestId) await finishUsageChat(db, usageRequestId, disconnected() ? "interrupted" : "success");
                if (!disconnected()) await writeAudit(db, {
                    actor,
                    action: "chat.completed",
                    targetType: "model",
                    targetId: execution.modelConfigId,
                    result: "success",
                    detail: { protocol: model.protocol, streaming: true, toolKey: execution.toolKey, configurationVersion: execution.configurationVersion },
                    ip: request.ip,
                });
                await finishChatBilling(db, billingReservationId, !disconnected() && streamOutcome.successful);
                billingReservationId = null;
                response.end();
                return;
            }
            let resultPayload = await requestChatCompletion(model, credentials, input);
            providerInFlight = false;
            if (prepared.privateRules.length) {
                resultPayload = validateChatProfileOutput(resultPayload, prepared.privateRules);
                await options.validateProfileOutput?.(resultPayload, prepared.privateRules);
            }
            if (!resultPayload.content.trim() && !resultPayload.toolCalls.length) throw new ChatProtocolError("CHAT_RESPONSE_EMPTY", "模型未返回有效回复，本次不扣积分");
            if (usageRequestId) await finishUsageChat(db, usageRequestId, disconnected() ? "interrupted" : "success");

            if (!disconnected()) await writeAudit(db, {
                actor,
                action: "chat.completed",
                targetType: "model",
                targetId: execution.modelConfigId,
                result: "success",
                detail: { protocol: model.protocol, toolCallCount: resultPayload.toolCalls.length, toolKey: execution.toolKey, configurationVersion: execution.configurationVersion },
                ip: request.ip,
            });
            // Capture only after required bookkeeping succeeds. A failed audit or
            // usage write must still follow the held-reservation refund path.
            await finishChatBilling(db, billingReservationId, !disconnected());
            billingReservationId = null;
            const { usage: _internalUsage, ...publicPayload } = resultPayload;
            response.json(publicPayload);
        } catch (error) {
            if (billingReservationId) await finishChatBilling(db, billingReservationId, false).catch((releaseError) => {
                const { code, name } = chatErrorMetadata(releaseError);
                console.error("Chat credit release failed", { code, name, phase: "credit_release", elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) });
            });
            if (usageRequestId) await finishUsageChat(db, usageRequestId, disconnected() ? "interrupted" : "failed").catch(() => undefined);
            const diagnostics = readProviderSubmissionDiagnostics(error);
            const metadata = chatErrorMetadata(error);
            console.error("Chat request failed", {
                code: metadata.timeout ? metadata.code : diagnostics?.code || metadata.code,
                name: metadata.name,
                phase: diagnostics?.phase || (response.headersSent ? "response" : "request"),
                elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
            });
            if (disconnected()) return;
            if (response.headersSent) {
                const failure = metadata.timeout
                    ? { code: "CHAT_REQUEST_TIMEOUT", message: CHAT_REQUEST_TIMEOUT_MESSAGE }
                    : error instanceof ChatProtocolError && error.code === "CHAT_STREAM_INCOMPLETE"
                        ? { code: "CHAT_STREAM_INCOMPLETE", message: "对话流未完整返回有效回复，本轮对话未完成，不会自动重新提交。" }
                        : { code: "CHAT_STREAM_INTERRUPTED", message: "对话流已中断，请求已发出，结果待核查，不会自动重新提交。请联系管理员核查上游记录后，再决定是否重新发送。" };
                response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: failure })}\n\n`);
                return;
            }
            if (metadata.timeout) {
                response.status(504).json({ error: "CHAT_REQUEST_TIMEOUT", message: CHAT_REQUEST_TIMEOUT_MESSAGE });
                return;
            }
            if (error instanceof PromptOptimizationError) {
                response.status(error.status).json({ error: error.code, message: error.message });
                return;
            }
            if (diagnostics) {
                const notSubmitted = diagnostics.phase === "initial_tls" || diagnostics.phase === "preflight";
                next(new ChatProtocolError("UPSTREAM_REQUEST_FAILED", notSubmitted
                    ? "连接对话模型服务失败，模型业务请求尚未发送。请联系管理员检查服务端网络、代理或运行环境后再试。"
                    : "对话模型连接中断，请求可能已发出，结果待核查，不会自动重新提交。请联系管理员核查上游记录后，再决定是否重新发送。"));
                return;
            }
            if (providerInFlight && !(error instanceof ChatProtocolError)) {
                // The global unknown-error handler logs raw errors. Provider
                // failures are already recorded as safe metadata above.
                response.status(500).json({ error: "INTERNAL_ERROR", message: "服务器处理失败" });
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
    input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
    if (!(CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(model.protocol)) throw new ChatProtocolError("PROTOCOL_NOT_SUPPORTED", "当前对话入口暂不支持该 Provider 协议");
    const usesResponses = model.protocol === "openai" || model.protocol === "custom" || (model.protocol === "apimart" && model.model_id === "gpt-6-astra");
    if (!usesResponses && input.input.some(item => "type" in item && item.type === "responses_assistant"))
        throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "该会话包含 Responses 原生工具记录，请新建对话后切换接口协议。");
    // GPT-6 Astra function tools require Responses on Mark. Choose before submission; never retry another endpoint.
    if (model.protocol === "apimart" && model.model_id === "gpt-6-astra") return requestOpenAiCompletion(model, credentials, input);
    if (model.protocol === "gemini") return requestGeminiCompletion(model, credentials, input);
    if (isClaudeMessagesModel(model)) return requestClaudeCompletion(model, credentials, input);
    if (model.protocol === "openai-chat" || model.protocol === "apimart") return requestOpenAiChatCompletion(model, credentials, input);
    if (model.protocol === "openai" || model.protocol === "custom") return requestOpenAiCompletion(model, credentials, input);
    throw new ChatProtocolError("PROTOCOL_NOT_SUPPORTED", "当前对话入口暂不支持该 Provider 协议");
}

async function requestClaudeCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: ChatCompletionInput,
) {
    const upstream = await fetchProviderSubmission(claudeMessagesUrl(model.base_url), {
        method: "POST",
        headers: claudeHeaders(credentials, model.protocol),
        body: JSON.stringify({ model: model.model_id, ...buildClaudeMessagesRequest(input, { modelId: model.model_id, maxTokens: input.claude?.maxTokens || 2048, thinking: input.claude?.thinking }) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Claude Provider", upstream, model.protocol === "apimart" || input.privateProfile);
    return readClaudeResponse(await readNativeChatPayload(upstream) as ClaudeResponse);
}

async function readNativeChatPayload(upstream: Response): Promise<Record<string, unknown>> {
    // Native Claude/Gemini arguments are nested objects, not strings. Parsing the
    // envelope with Response.json() first would irreversibly lose duplicate keys.
    // Read failures retain their transport diagnostics; only JSON errors map here.
    const raw = await upstream.text();
    let parsed: unknown;
    try {
        parsed = parseStrictJson(raw);
    } catch (error) {
        if (error instanceof DuplicateJsonKeyError) {
            throw new ChatProtocolError("CHAT_RESPONSE_DUPLICATE_KEYS", "模型响应包含重复 JSON 键，无法确认完整要求，已停止工具执行；不会自动重新提交。");
        }
        if (!(error instanceof SyntaxError)) throw error;
        throw new ChatProtocolError("CHAT_RESPONSE_INVALID_JSON", "模型未返回有效 JSON 对象，已停止工具执行；不会自动重新提交。");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ChatProtocolError("CHAT_RESPONSE_INVALID_JSON", "模型未返回有效 JSON 对象，已停止工具执行；不会自动重新提交。");
    }
    return parsed as Record<string, unknown>;
}

export async function requestClaudeStream(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; claude?: { thinking?: boolean; maxTokens?: number } },
) {
    const upstream = await fetchProviderSubmission(claudeMessagesUrl(model.base_url), {
        method: "POST",
        headers: claudeHeaders(credentials, model.protocol),
        body: JSON.stringify({ model: model.model_id, ...buildClaudeMessagesRequest(input, { modelId: model.model_id, maxTokens: input.claude?.maxTokens || 2048, thinking: input.claude?.thinking, stream: true }) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Claude Provider", upstream, model.protocol === "apimart");
    if (!upstream.body) throw new ChatProtocolError("CLAUDE_STREAM_EMPTY", "Claude 流式响应为空");
    return upstream;
}

function claudeMessagesUrl(baseUrl: string) {
    return `${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/messages`;
}

function claudeHeaders(credentials: Record<string, string>, protocol: string) {
    const headers = requestHeaders(credentials);
    // APIMart documents either Bearer or x-api-key, not a second credential.
    if (protocol === "apimart") {
        // Use Anthropic's published Messages version; APIMart's optional
        // header example contains a version absent from its version history.
        headers.set("anthropic-version", ANTHROPIC_MESSAGES_VERSION);
        return headers;
    }
    // OpenToken documents Bearer auth; retain x-api-key for existing native providers.
    if (credentials.apiKey) headers.set("x-api-key", credentials.apiKey);
    headers.set("anthropic-version", ANTHROPIC_MESSAGES_VERSION);
    return headers;
}

export function buildClaudeMessagesRequest(
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; privateProfile?: boolean },
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
            // Private profiles rebuild context/tools between stages. Sonnet 5.5
            // binds reasoning to the original prefix, so it cannot be replayed
            // here. Keep visible text and exact tool calls/results; leave saved
            // history and ordinary append-only conversations untouched.
            // https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
            const content = input.privateProfile && options.modelId?.toLowerCase() === "claude-sonnet-5-5"
                ? item.content.filter(block => block.type !== "thinking" && block.type !== "redacted_thinking")
                : item.content;
            for (const block of content) {
                if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") calls.set(block.id, block.name);
            }
            if (content.length) messages.push({ role: "assistant", content });
            continue;
        }
        if (item.type === "function_call") {
            calls.set(item.call_id, item.name);
            messages.push({ role: "assistant", content: [{ type: "tool_use", id: item.call_id, name: item.name, input: parseJsonObject(item.arguments) }] });
            continue;
        }
        if (item.type === "responses_assistant") throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "该会话包含 Responses 原生工具记录，请新建对话后切换接口协议。");
        const name = calls.get(item.call_id);
        if (name) messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id, content: item.output }] });
    }
    let allowedTools = input.tools, toolChoice = toClaudeToolChoice(input.toolChoice), toolInstruction = "";
    // Sonnet 5.5 rejects forced tool/any choices on every platform. Auto is not
    // an execution guarantee: keep the allowed scope and caller-side validation.
    // https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
    if (options.modelId?.trim().toLowerCase() === "claude-sonnet-5-5") {
        const noTools = input.toolChoice === "none" || (input.toolChoice && typeof input.toolChoice === "object" && "type" in input.toolChoice && input.toolChoice.type === "none");
        if (noTools) toolChoice = { type: "none" };
        else if (toolChoice.type === "tool") {
            allowedTools = input.tools.filter(tool => tool.name === toolChoice.name);
            if (allowedTools.length !== 1) throw new ChatProtocolError("CLAUDE_TOOL_CHOICE_INVALID", "指定工具不存在或不唯一，未发送模型请求。");
            toolInstruction = `For this request, call only the tool ${JSON.stringify(allowedTools[0]!.name)}.`;
            toolChoice = { type: "auto" };
        } else if (toolChoice.type === "any") {
            if (!allowedTools.length) throw new ChatProtocolError("CLAUDE_TOOL_CHOICE_INVALID", "本轮没有可调用工具，未发送模型请求。");
            toolInstruction = "For this request, call an available tool.";
            toolChoice = { type: "auto" };
        }
    }
    const tools = allowedTools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.parameters,
    }));
    return {
        ...(system || toolInstruction ? { system: [system, toolInstruction].filter(Boolean).join("\n\n") } : {}),
        messages,
        max_tokens: Math.max(1, Math.floor(options.maxTokens || 2048)),
        ...(tools.length ? { tools, tool_choice: toolChoice } : {}),
        ...(options.stream ? { stream: true } : {}),
        ...claudeThinkingParameters(options),
    };
}

function claudeThinkingParameters(options: { modelId?: string; maxTokens: number; thinking?: boolean }) {
    // Preserve this alias's thinking mode; an explicit fast-chat choice only
    // lowers effort. Omitted/true keeps the upstream default without overrides.
    if (options.modelId?.toLowerCase() === "claude-sonnet-5-5") return options.thinking === false ? { output_config: { effort: "low" } } : {};
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
        ...usageResult(body, "anthropic"),
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
    input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
    const responseInput = input.input.flatMap((item): Array<Record<string, unknown>> => {
        if (!("type" in item)) return [item];
        if (item.type === "claude_assistant") throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "该会话包含 Claude 原生工具记录，请新建对话后切换接口协议。");
        if (item.type !== "responses_assistant") return [item];
        const checked = z.array(z.record(z.string(), z.unknown())).safeParse(item.output);
        if (!checked.success) throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "Responses 原生工具记录无效，请新建对话。");
        return checked.data;
    });
    const upstream = await fetchProviderSubmission(`${model.base_url.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({
            model: model.model_id,
            input: responseInput,
            tools: input.tools,
            tool_choice: input.toolChoice ?? "auto",
            parallel_tool_calls: false,
            ...(model.protocol === "apimart" ? { stream: false, ...(input.tools.length ? { include: ["reasoning.encrypted_content"] } : {}) } : {}),
        }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("对话 Provider", upstream, model.protocol === "apimart" || input.privateProfile);
    if (model.protocol === "apimart") return readApiMartResponses(await readApiMartChatPayload(upstream));

    const body = await upstream.json() as {
        status?: string;
        error?: unknown;
        output_text?: string;
        output?: Array<{ type?: string; status?: string; content?: Array<{ text?: string }>; id?: string; call_id?: string; name?: string; arguments?: string; thoughtSignature?: string }>;
    };
    // HTTP 200 can contain a failed or incomplete Responses operation with
    // partial text. It is not a completed model call and must take the refund path.
    if (body.error || (body.status !== undefined && body.status !== "completed")
        || body.output?.some(item => item.status !== undefined && item.status !== "completed")) {
        throw new ChatProtocolError("CHAT_RESPONSE_INCOMPLETE", "模型未完整返回有效回复，本次不扣积分");
    }
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
    return { content, toolCalls, ...usageResult(body) };
}

function invalidApiMartChatResponse() {
    return new ChatProtocolError("APIMART_CHAT_INVALID_RESPONSE", "Mark 对话服务未返回有效回复；本次请求不会重新提交。");
}

async function readApiMartChatPayload(upstream: Response): Promise<Record<string, unknown>> {
    if (upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        await upstream.body?.cancel().catch(() => {});
        throw new ChatProtocolError("APIMART_CHAT_UNEXPECTED_STREAM", "Mark 对话服务未遵循非流式请求；本次请求不会重新提交。");
    }
    let received: unknown;
    try { received = await upstream.json(); } catch (error) {
        if (readProviderSubmissionDiagnostics(error) || chatErrorMetadata(error).timeout) throw error;
        throw invalidApiMartChatResponse();
    }
    if (!received || typeof received !== "object" || Array.isArray(received)) throw invalidApiMartChatResponse();
    const envelope = received as Record<string, unknown>;
    if (envelope.error || (envelope.code !== undefined && envelope.code !== 200)) throw invalidApiMartChatResponse();
    const body = envelope.data ?? envelope;
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).error) throw invalidApiMartChatResponse();
    return { ...(body as Record<string, unknown>),
        ...(body !== envelope && !Object.prototype.hasOwnProperty.call(body, "usage") && envelope.usage ? { usage: envelope.usage } : {}),
        ...(body !== envelope && !Object.prototype.hasOwnProperty.call(body, "actual_cost") && envelope.actual_cost !== undefined ? { actual_cost: envelope.actual_cost } : {}),
        ...(body !== envelope && !Object.prototype.hasOwnProperty.call(body, "currency") && envelope.currency !== undefined ? { currency: envelope.currency } : {}),
    };
}

function readApiMartChatChoices(body: Record<string, unknown>): ChatCompletionResult {
    const checked = z.object({ choices: z.array(z.object({
        message: z.object({
            content: z.string().nullable().optional(),
            tool_calls: z.array(z.object({
                id: z.string().min(1), type: z.literal("function"),
                function: z.object({ name: z.string().min(1), arguments: z.string() }),
            })).optional(),
        }),
        finish_reason: z.string().optional(),
    })).min(1) }).safeParse(body);
    if (!checked.success) throw invalidApiMartChatResponse();
    const choice = checked.data.choices[0]!;
    const content = choice.message.content || "";
    const toolCalls = choice.message.tool_calls || [];
    if (!content.trim() && !toolCalls.length) throw invalidApiMartChatResponse();
    return { content, toolCalls, ...(choice.finish_reason ? { stopReason: choice.finish_reason } : {}), ...usageResult(body) };
}

function readApiMartResponses(body: Record<string, unknown>): ChatCompletionResult {
    if (body.status !== undefined && body.status !== "completed") throw invalidApiMartChatResponse();
    // The provider documents a choices envelope even for /responses. Parse it without making another request.
    if (body.output === undefined && body.output_text === undefined && body.choices !== undefined) return readApiMartChatChoices(body);
    const checked = z.object({ output: z.array(z.record(z.string(), z.unknown())).optional(), output_text: z.string().optional() }).safeParse(body);
    if (!checked.success) throw invalidApiMartChatResponse();
    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const item of checked.data.output || []) {
        if (item.status !== undefined && item.status !== "completed") throw invalidApiMartChatResponse();
        if (item.type === "reasoning") continue;
        if (item.type === "function_call") {
            const call = z.object({ call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }).safeParse(item);
            if (!call.success) throw invalidApiMartChatResponse();
            toolCalls.push({ id: call.data.call_id, type: "function", function: { name: call.data.name, arguments: call.data.arguments } });
        } else if (item.type === "message") {
            const message = z.object({ content: z.array(z.discriminatedUnion("type", [
                z.object({ type: z.literal("output_text"), text: z.string() }),
                z.object({ type: z.literal("refusal"), refusal: z.string() }),
            ])) }).safeParse(item);
            if (!message.success) throw invalidApiMartChatResponse();
            text.push(...message.data.content.map(part => part.type === "output_text" ? part.text : part.refusal));
        } else throw invalidApiMartChatResponse();
    }
    const content = checked.data.output_text || text.join("");
    if (!content.trim() && !toolCalls.length) throw invalidApiMartChatResponse();
    return { content, toolCalls, stopReason: toolCalls.length ? "tool_calls" : "stop",
        ...(toolCalls.length && checked.data.output ? { responsesOutputItems: checked.data.output } : {}),
        ...usageResult(body),
    };
}

async function requestOpenAiChatCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: ChatCompletionInput,
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
    const upstream = await fetchProviderSubmission(`${model.base_url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({
            model: model.model_id,
            messages,
            // APIMart documents stream=true by default. This endpoint returns one JSON result.
            ...(model.protocol === "apimart" ? { stream: false } : {}),
            ...(input.tools.length ? {
                tools: input.tools.map(({ type, ...definition }) => ({ type, function: definition })),
                tool_choice: toolChoice,
                parallel_tool_calls: false,
            } : {}),
        }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Chat Completions Provider", upstream, model.protocol === "apimart" || input.privateProfile);
    if (model.protocol === "apimart") return readApiMartChatChoices(await readApiMartChatPayload(upstream));
    const body = await upstream.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }> };
    const choice = body.choices?.[0];
    return { content: choice?.message?.content || "", toolCalls: choice?.message?.tool_calls || [], ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}), ...usageResult(body) };
}

async function requestGeminiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: ChatCompletionInput,
) {
    const upstream = await fetchProviderSubmission(buildGeminiGenerateUrl(model.base_url, model.model_id), {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify(buildGeminiRequestBody(input)),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Gemini Provider", upstream, input.privateProfile);

    return readGeminiResponse(await readNativeChatPayload(upstream) as GeminiResponse, { privateProfile: input.privateProfile });
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

export function readGeminiResponse(body: GeminiResponse, options: { privateProfile?: boolean } = {}): ChatCompletionResult {
    const candidates = body.data?.candidates || body.candidates || [];
    const parts = candidates.flatMap((candidate) => candidate.content?.parts || []).filter(part => !options.privateProfile || !part.thought);
    return {
        content: withGroundingSources(parts.map((part) => part.text || "").join(""), candidates),
        toolCalls: parts.flatMap((part) => part.functionCall?.name ? [{
            id: crypto.randomUUID(), type: "function" as const,
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        }] : []),
        ...usageResult(body.data || body, "gemini"),
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

/** Provider-reported accounting only. Missing fields stay unknown, never estimated as zero. */
export function readChatUsage(body: unknown, protocol?: "anthropic" | "gemini"): ChatCompletionUsage | undefined {
    const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const root = record(body), usage = record(root.usage), gemini = record(root.usageMetadata);
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const tokens = (value: unknown) => { const count = number(value); return count !== undefined && Number.isSafeInteger(count) ? count : undefined; };
    let inputTokens = tokens(usage.input_tokens ?? usage.prompt_tokens);
    let outputTokens = tokens(usage.output_tokens ?? usage.completion_tokens);
    if (protocol === "anthropic" && inputTokens !== undefined) inputTokens += (tokens(usage.cache_creation_input_tokens) || 0) + (tokens(usage.cache_read_input_tokens) || 0);
    if (protocol === "gemini") {
        inputTokens = tokens(gemini.promptTokenCount);
        const candidates = tokens(gemini.candidatesTokenCount);
        outputTokens = candidates === undefined ? undefined : candidates + (tokens(gemini.thoughtsTokenCount) || 0);
    }
    const cost = record(usage.cost ?? root.cost);
    const actualCost = number(usage.actualCost ?? usage.actual_cost ?? usage.total_cost ?? usage.cost ?? root.actualCost ?? root.actual_cost ?? root.cost) ?? number(cost.amount);
    const rawCurrency = usage.currency ?? root.currency ?? cost.currency;
    const currency = typeof rawCurrency === "string" && /^[a-z]{3}$/i.test(rawCurrency) ? rawCurrency.toUpperCase() : undefined;
    const result = { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(actualCost === undefined ? {} : { actualCost }), ...(currency === undefined ? {} : { currency }) };
    return Object.keys(result).length ? result : undefined;
}

function usageResult(body: unknown, protocol?: "anthropic" | "gemini") {
    const usage = readChatUsage(body, protocol);
    return usage ? { usage } : {};
}

async function upstreamError(label: string, upstream: Response, suppressProviderBody = false) {
    // Mark can echo request headers in an error body. Retain its HTTP status,
    // never expose that body to clients, and never submit a fallback request.
    if (suppressProviderBody) {
        await upstream.body?.cancel().catch(() => {});
        return new ChatProtocolError("UPSTREAM_REQUEST_FAILED", `${label} ${upstream.status}: 上游服务拒绝了请求；本次请求不会重新提交。`, upstream.status);
    }
    const detail = (await upstream.text()).slice(0, 500);
    return new ChatProtocolError("UPSTREAM_REQUEST_FAILED", `${label} ${upstream.status}: ${detail}`, upstream.status);
}

export class ChatProtocolError extends Error {
    constructor(readonly code: string, message: string, readonly upstreamStatus?: number) {
        super(message);
    }
}

type GeminiResponse = {
    data?: { candidates?: GeminiCandidate[]; usageMetadata?: Record<string, unknown>; usage?: Record<string, unknown> };
    candidates?: GeminiCandidate[];
    usageMetadata?: Record<string, unknown>;
};
type GeminiCandidate = {
    content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
};

type ClaudeResponse = {
    stop_reason?: string;
    usage?: Record<string, unknown>;
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
