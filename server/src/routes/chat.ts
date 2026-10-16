import { Router } from "express";
import { z } from "zod";

import { writeAudit } from "../audit";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { resolveToolExecution } from "../tool-configuration";
import { decryptSecret } from "../security";
import { fetchProviderSubmission } from "../provider-submission-transport";
import type { AuthenticatedRequest } from "../types";
import { beginUsageChat, finishUsageChat } from "../usage-analytics";
import { beginChatBilling, ChatStreamOutcome, finishChatBilling } from "../chat-billing";
import { getCreditsEnabled } from "../credit-policy";
import { deploymentFeatures } from "../deployment-features";

type ResponseContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInput =
    | { role: "system" | "user" | "assistant"; content: string | ResponseContent[] }
    | { type: "claude_assistant"; content: Array<Record<string, unknown>> }
    | { type: "responses_assistant"; output: Array<Record<string, unknown>> }
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string };
type ChatCompletionResult = { content: string; toolCalls: ToolCall[]; stopReason?: string; claudeAssistantContent?: Array<Record<string, unknown>>; responsesOutputItems?: Array<Record<string, unknown>> };
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

export function createChatRouter(db: Database, config: AppConfig) {
    const router = Router();
    const features = deploymentFeatures(config);

    router.post("/responses", async (request, response, next) => {
        let usageRequestId: string | undefined;
        let billingReservationId: string | null = null;
        const socket = request.socket;
        const hadRemoteAddress = Boolean(socket?.remoteAddress);
        // Bun 1.3.x can lose its native socket without setting destroyed or
        // emitting ServerResponse.close. Its public peer address then disappears.
        const disconnected = () => Boolean(response.destroyed || request.aborted || socket?.destroyed
            || (hadRemoteAddress && !socket.remoteAddress));
        try {
            const input = schema.parse(request.body) as {
                requestId?: string;
                modelId?: string;
                toolKey?: string;
                input: ResponseInput[];
                tools: ResponseTool[];
                toolChoice?: unknown;
                webSearch?: boolean;
                gemini?: { maxOutputTokens: number };
                claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number };
            };
            const execution = await resolveToolExecution(db, { ...input, operationType: "chat" });

            const actor = (request as unknown as AuthenticatedRequest).auth;
            const result = await db.query<ChatModel>(
                `SELECT m.model_id,p.base_url,p.protocol,p.encrypted_credentials
                 FROM model_configs m JOIN providers p ON p.id=m.provider_id
                 WHERE (m.id::text=$1 OR m.model_id=$1)
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
            if (features.oaLoginEnabled && !(request as AuthenticatedRequest).allowsAnonymousCreation) {
                usageRequestId = await beginUsageChat(db, { userId: actor.id, modelConfigId: execution.modelConfigId, boardKey: execution.toolKey, input: input.input });
            }
            if (isClaudeMessagesModel(model) && input.claude?.stream) {
                const upstream = await requestClaudeStream(model, credentials, input);
                response.setHeader("content-type", "text/event-stream; charset=utf-8");
                response.setHeader("cache-control", "no-cache");
                const streamOutcome = new ChatStreamOutcome();
                for await (const chunk of upstream.body!) {
                    if (disconnected()) break;
                    streamOutcome.push(chunk);
                    response.write(chunk);
                }
                if (!disconnected() && !streamOutcome.successful) throw new ChatProtocolError("CHAT_STREAM_INCOMPLETE", "对话流未完整返回有效回复，本次不扣积分");
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
            const resultPayload = await requestChatCompletion(model, credentials, input);
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
            response.json(resultPayload);
        } catch (error) {
            if (billingReservationId) await finishChatBilling(db, billingReservationId, false).catch((releaseError) => console.error("Chat credit release failed", { reservationId: billingReservationId, code: releaseError?.code }));
            if (usageRequestId) await finishUsageChat(db, usageRequestId, disconnected() ? "interrupted" : "failed").catch(() => undefined);
            if (disconnected()) return;
            if (response.headersSent) {
                response.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "对话流已中断，请重试。" } })}\n\n`);
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
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number } },
) {
    const upstream = await fetchProviderSubmission(claudeMessagesUrl(model.base_url), {
        method: "POST",
        headers: claudeHeaders(credentials, model.protocol),
        body: JSON.stringify({ model: model.model_id, ...buildClaudeMessagesRequest(input, { modelId: model.model_id, maxTokens: input.claude?.maxTokens || 2048, thinking: input.claude?.thinking }) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Claude Provider", upstream, model.protocol === "apimart");
    return readClaudeResponse(await upstream.json() as ClaudeResponse);
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
        if (item.type === "responses_assistant") throw new ChatProtocolError("CHAT_HISTORY_PROTOCOL_MISMATCH", "该会话包含 Responses 原生工具记录，请新建对话后切换接口协议。");
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
    // APIMart's Messages contract does not specify this alias's thinking mode.
    // Keep the upstream default instead of guessing adaptive or legacy budgets.
    if (options.modelId?.toLowerCase() === "claude-sonnet-5-5") return {};
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
    if (!upstream.ok) throw await upstreamError("对话 Provider", upstream, model.protocol === "apimart");
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
    return { content, toolCalls };
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
    try { received = await upstream.json(); } catch { throw invalidApiMartChatResponse(); }
    if (!received || typeof received !== "object" || Array.isArray(received)) throw invalidApiMartChatResponse();
    const envelope = received as Record<string, unknown>;
    if (envelope.error || (envelope.code !== undefined && envelope.code !== 200)) throw invalidApiMartChatResponse();
    const body = envelope.data ?? envelope;
    if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>).error) throw invalidApiMartChatResponse();
    return body as Record<string, unknown>;
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
    return { content, toolCalls, ...(choice.finish_reason ? { stopReason: choice.finish_reason } : {}) };
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
    };
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
    if (!upstream.ok) throw await upstreamError("Chat Completions Provider", upstream, model.protocol === "apimart");
    if (model.protocol === "apimart") return readApiMartChatChoices(await readApiMartChatPayload(upstream));
    const body = await upstream.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }> };
    const choice = body.choices?.[0];
    return { content: choice?.message?.content || "", toolCalls: choice?.message?.tool_calls || [], ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}) };
}

async function requestGeminiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean; gemini?: { maxOutputTokens: number } },
) {
    const upstream = await fetchProviderSubmission(buildGeminiGenerateUrl(model.base_url, model.model_id), {
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

async function upstreamError(label: string, upstream: Response, suppressProviderBody = false) {
    // Mark can echo request headers in an error body. Retain its HTTP status,
    // never expose that body to clients, and never submit a fallback request.
    if (suppressProviderBody) {
        await upstream.body?.cancel().catch(() => {});
        return new ChatProtocolError("UPSTREAM_REQUEST_FAILED", `${label} ${upstream.status}: 上游服务拒绝了请求；本次请求不会重新提交。`);
    }
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
