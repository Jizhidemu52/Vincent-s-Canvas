import type { ApiErrorCode, CreateConversationRequest, ErrorDetails, SubmitTurnRequest } from "../../../../shared/image-conversation-contracts";
import { designExecutionHistoryPageSchema } from "../../../../shared/design-conversation-history";
import type { PublicConversationEvent as ConversationEvent } from "../../../../shared/image-conversation-public";
import { createConversationRequestSchema, submitTurnRequestSchema } from "../../../../shared/image-conversation-schemas";
import { cancellationResultSchema, conversationEventSchema, conversationPageSchema, conversationSnapshotSchema, messagePageSchema, turnDetailsSchema, turnPageSchema, turnSubmissionResultSchema, versionPageSchema } from "../../../../shared/image-conversation-public-schemas";
import { workspaceOwnerHeaders } from "./workspace-owner";
import { useUserStore } from "@/stores/use-user-store";

export class ImageConversationApiError extends Error {
    constructor(readonly status: number, readonly code: ApiErrorCode | "INVALID_RESPONSE", message: string, readonly details: ErrorDetails | null = null) { super(message); this.name = "ImageConversationApiError"; }
}

type Decoder<T> = { parse(value: unknown): T };
type Fetch = typeof globalThis.fetch;
const base = "/api/image-conversations";
const pathId = (id: string) => encodeURIComponent(id);

async function responseData<T>(response: Response, schema: Decoder<T>) {
    const value = await response.json().catch(() => null);
    if (!value || typeof value !== "object" || typeof value.code !== "string" || typeof value.msg !== "string" || !("data" in value)) {
        throw new ImageConversationApiError(response.status, "INVALID_RESPONSE", "会话回执格式不完整，请查询原请求，不要重复发送。");
    }
    if (!response.ok || value.code !== "OK") throw new ImageConversationApiError(response.status, value.code, value.msg || "会话请求未完成", value.data);
    try { return schema.parse(value.data); } catch { throw new ImageConversationApiError(response.status, "INVALID_RESPONSE", "会话数据校验失败，请查询原请求，不要重复发送。"); }
}

export function createImageConversationApi(ownerId: string, fetcher: Fetch = globalThis.fetch) {
    const assertOwner = () => { if (useUserStore.getState().user?.id !== ownerId) throw new Error("员工会话已变化，请重新登录。"); };
    const request = async <T>(path: string, schema: Decoder<T>, init: RequestInit = {}) => {
        assertOwner();
        const response = await fetcher(path, { ...init, credentials: "include", cache: "no-store", redirect: "error", headers: { ...workspaceOwnerHeaders(), ...init.headers } });
        assertOwner();
        const result = await responseData(response, schema);
        assertOwner();
        return result;
    };
    const post = <T>(path: string, schema: Decoder<T>, input: unknown, signal?: AbortSignal) => request(path, schema, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
    const page = (path: string, cursor?: string) => `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    return {
        create: (input: CreateConversationRequest, signal?: AbortSignal) => post(base, conversationSnapshotSchema, createConversationRequestSchema.parse(input), signal),
        createByRequest: (key: string, signal?: AbortSignal) => request(`${base}/by-request/${pathId(key)}`, conversationSnapshotSchema, { signal }),
        list: (cursor?: string, signal?: AbortSignal) => request(page(base, cursor), conversationPageSchema, { signal }),
        designExecutions: async (canvasExternalId: string, cursor?: string, signal?: AbortSignal) => {
            const result = await request(`${page(`${base}/design-executions`, cursor)}&canvasExternalId=${encodeURIComponent(canvasExternalId)}`, designExecutionHistoryPageSchema, { signal });
            if (result.items.some(item => item.canvasExternalId !== canvasExternalId)) throw new ImageConversationApiError(200, "INVALID_RESPONSE", "设计执行记录不属于当前画布。");
            return result;
        },
        snapshot: async (id: string, signal?: AbortSignal) => {
            const snapshot = await request(`${base}/${pathId(id)}`, conversationSnapshotSchema, { signal });
            if (snapshot.id !== id) throw new ImageConversationApiError(200, "INVALID_RESPONSE", "会话快照与请求编号不一致。");
            return snapshot;
        },
        messages: (id: string, cursor?: string, signal?: AbortSignal) => request(page(`${base}/${pathId(id)}/messages`, cursor), messagePageSchema, { signal }),
        versions: (id: string, cursor?: string, signal?: AbortSignal) => request(page(`${base}/${pathId(id)}/versions`, cursor), versionPageSchema, { signal }),
        turns: async (id: string, cursor?: string, signal?: AbortSignal) => {
            const result = await request(page(`${base}/${pathId(id)}/turns`, cursor), turnPageSchema, { signal });
            if (result.items.some(turn => turn.conversationId !== id)) throw new ImageConversationApiError(200, "INVALID_RESPONSE", "轮次记录与请求会话不一致。");
            return result;
        },
        submit: (id: string, input: SubmitTurnRequest, signal?: AbortSignal) => post(`${base}/${pathId(id)}/turns`, turnSubmissionResultSchema, submitTurnRequestSchema.parse(input), signal),
        byRequest: async (id: string, key: string, signal?: AbortSignal) => {
            const result = await request(`${base}/${pathId(id)}/turns/by-request/${pathId(key)}`, turnDetailsSchema, { signal });
            if (result.turn.conversationId !== id || result.turn.clientRequestId !== key) throw new ImageConversationApiError(200, "INVALID_RESPONSE", "原请求回执与请求编号不一致，不能重新发送。");
            return result;
        },
        turn: async (id: string, turnId: string, signal?: AbortSignal) => {
            const result = await request(`${base}/${pathId(id)}/turns/${pathId(turnId)}`, turnDetailsSchema, { signal });
            if (result.turn.conversationId !== id || result.turn.id !== turnId) throw new ImageConversationApiError(200, "INVALID_RESPONSE", "轮次回执与原请求不一致。");
            return result;
        },
        cancel: (id: string, turnId: string, expectedStateRevision: number, signal?: AbortSignal) => post(`${base}/${pathId(id)}/turns/${pathId(turnId)}/cancel`, cancellationResultSchema, { expectedStateRevision }, signal),
        async events(id: string, afterSeq: number, onEvent: (event: ConversationEvent) => Promise<void> | void, signal: AbortSignal) {
            assertOwner();
            const response = await fetcher(`${base}/${pathId(id)}/events?afterSeq=${afterSeq}`, { credentials: "include", cache: "no-store", redirect: "error", signal, headers: { ...workspaceOwnerHeaders(), Accept: "text/event-stream", "Last-Event-ID": String(afterSeq) } });
            assertOwner();
            if (!response.ok) await responseData(response, conversationSnapshotSchema);
            return readImageConversationEvents(response, id, afterSeq, async event => { assertOwner(); signal.throwIfAborted(); await onEvent(event); }, signal);
        },
    };
}

export async function readImageConversationEvents(response: Response, conversationId: string, afterSeq: number, onEvent: (event: ConversationEvent) => Promise<void> | void, signal: AbortSignal) {
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new Error("会话事件连接无效，将只读重新连接。");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", lastSeq = afterSeq;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
            if (buffer.length > 2_000_000) throw new Error("会话事件超过大小限制，将重新读取服务端状态。");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const lines = frame.split("\n"), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                if (data) {
                    const event = conversationEventSchema.parse(JSON.parse(data));
                    const id = lines.find(line => line.startsWith("id:"))?.slice(3).trim();
                    const type = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
                    const record = "version" in event.payload ? event.payload.version : "turn" in event.payload ? event.payload.turn : "message" in event.payload ? event.payload.message : null;
                    if (event.conversationId !== conversationId || id !== String(event.seq) || type !== event.type || (record && record.conversationId !== conversationId)) throw new Error("会话事件身份不一致，将重新读取服务端状态。");
                    if (event.seq > lastSeq) { await onEvent(event); lastSeq = event.seq; }
                }
                boundary = buffer.indexOf("\n\n");
            }
            if (done) return lastSeq;
        }
    } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function allConversationPages<T>(read: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>) {
    const items: T[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await read(cursor);
        items.push(...page.items);
        cursor = page.nextCursor || undefined;
        if (cursor && seen.has(cursor)) throw new Error("会话分页游标重复，请重新读取。");
        if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
}
