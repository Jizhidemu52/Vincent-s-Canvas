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
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string };
type ChatModel = { model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null };

const schema = z.object({
    modelId: z.string().min(1).max(200),
    input: z.array(z.unknown()).max(200),
    tools: z.array(z.unknown()).max(100).default([]),
    toolChoice: z.unknown().optional(),
    webSearch: z.boolean().optional(),
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
            next(error);
        }
    });

    return router;
}

export async function requestChatCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
    if (model.protocol === "gemini") return requestGeminiCompletion(model, credentials, input);
    if (model.protocol === "openai" || model.protocol === "custom") return requestOpenAiCompletion(model, credentials, input);
    throw new ChatProtocolError("PROTOCOL_NOT_SUPPORTED", "当前对话入口暂不支持该 Provider 协议");
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

async function requestGeminiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean },
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

export function buildGeminiRequestBody(input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown; webSearch?: boolean }) {
    const declarations = input.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
    }));
    const tools = [
        ...(declarations.length ? [{ functionDeclarations: declarations }] : []),
        ...(input.webSearch ? [{ googleSearch: {} }] : []),
    ];
    return {
        contents: toGeminiContents(input.input),
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
