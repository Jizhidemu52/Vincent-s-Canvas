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
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseTool = { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string };
type ChatModel = { model_id: string; base_url: string; protocol: string; encrypted_credentials: string | null };

const schema = z.object({
    modelId: z.string().min(1).max(200),
    input: z.array(z.unknown()).max(200),
    tools: z.array(z.unknown()).max(100).default([]),
    toolChoice: z.unknown().optional(),
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
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
    if (model.protocol === "gemini") return requestGeminiCompletion(model, credentials, input);
    if (model.protocol === "openai" || model.protocol === "custom") return requestOpenAiCompletion(model, credentials, input);
    throw new ChatProtocolError("PROTOCOL_NOT_SUPPORTED", "当前对话入口暂不支持该 Provider 协议");
}

async function requestOpenAiCompletion(
    model: ChatModel,
    credentials: Record<string, string>,
    input: { input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown },
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
    input: { input: ResponseInput[]; tools: ResponseTool[] },
) {
    if (input.tools.length > 0 || input.input.some((item) => "type" in item && item.type.startsWith("function_call"))) {
        throw new ChatProtocolError(
            "GEMINI_TOOLS_NOT_SUPPORTED",
            "当前 Gemini 原生对话配置不支持函数工具调用；请改用无工具对话，或在管理员后台选择支持 Responses 工具调用的模型。",
        );
    }

    const upstream = await fetch(buildGeminiGenerateUrl(model.base_url, model.model_id), {
        method: "POST",
        headers: requestHeaders(credentials),
        body: JSON.stringify({ contents: toGeminiContents(input.input) }),
        signal: AbortSignal.timeout(180000),
    });
    if (!upstream.ok) throw await upstreamError("Gemini Provider", upstream);

    const body = await upstream.json() as GeminiResponse;
    const content = (body.data?.candidates || body.candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => part.text || "")
        .join("");
    return { content, toolCalls: [] };
}

export function buildGeminiGenerateUrl(baseUrl: string, modelId: string) {
    const root = baseUrl.replace(/\/$/, "").replace(/\/v1(?:beta)?$/, "");
    return `${root}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
}

export function toGeminiContents(input: ResponseInput[]) {
    return input
        .filter((item): item is Extract<ResponseInput, { role: string }> => "role" in item)
        .map((item) => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: toGeminiParts(item.content),
        }));
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
type GeminiCandidate = { content?: { parts?: Array<{ text?: string }> } };
