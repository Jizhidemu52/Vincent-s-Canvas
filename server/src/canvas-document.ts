import { z } from "zod";

export const CANVAS_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export class CanvasDocumentError extends Error {
    constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export type CanvasDocumentEnvelope = {
    id: string; revision: number; deleted: boolean; document: Record<string, unknown> | null; updatedAt: string;
};

const idSchema = z.string().min(1).max(200).refine(value => value.trim().length > 0);
const dateSchema = z.string().min(1).refine(value => Number.isFinite(Date.parse(value)));
const pointSchema = z.object({ x: z.number(), y: z.number() }).passthrough();
const nodeSchema = z.object({
    id: idSchema, type: z.enum(["image", "text", "config", "video", "audio"]), title: z.string(),
    position: pointSchema, width: z.number().positive(), height: z.number().positive(),
    metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const messageSchema = z.object({
    id: idSchema, role: z.enum(["user", "assistant", "system", "tool", "error"]), text: z.string(),
}).passthrough();
const documentSchema = z.object({
    id: idSchema, title: z.string().max(1000), createdAt: dateSchema, updatedAt: dateSchema,
    nodes: z.array(nodeSchema),
    connections: z.array(z.object({ id: idSchema, fromNodeId: idSchema, toNodeId: idSchema }).passthrough()),
    chatSessions: z.array(z.object({ id: idSchema, title: z.string(), messages: z.array(messageSchema), createdAt: dateSchema, updatedAt: dateSchema }).passthrough()),
    activeChatId: idSchema.nullable(), backgroundMode: z.enum(["dots", "lines", "blank"]), showImageInfo: z.boolean(),
    viewport: z.object({ x: z.number(), y: z.number(), k: z.number().positive() }).passthrough(),
}).passthrough();
const writeSchema = z.object({ baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), document: documentSchema.nullable() });
const mediaField = /^(?:url|src|dataUrl|poster|posterUrl|thumbnail|thumbnailUrl|previewUrl|imageUrl|videoUrl|audioUrl|resultUrl|downloadUrl|coverUrl)$/i;
const localMedia = /^(?:blob:|data:|file:|image:|video:|audio:|media:)/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertCanvasOwner(ownerHeader: unknown, actorId: string): void {
    if (typeof ownerHeader !== "string" || ownerHeader !== actorId) {
        throw new CanvasDocumentError("CANVAS_OWNER_MISMATCH", "画布所属账号已变化，请刷新后重新打开", 403);
    }
}

/** Media fields only: prompts and text content may legitimately mention local URL syntax. */
function collectMediaAssets(value: unknown): string[] {
    const ids = new Set<string>();
    const inspectMedia = (input: string) => {
        const source = input.trim();
        if (localMedia.test(source)) throw new CanvasDocumentError("CANVAS_LOCAL_MEDIA", "请先将画布中的本地媒体上传后再同步");
        let path: string;
        try { path = decodeURIComponent(new URL(source, "https://canvas.invalid").pathname); }
        catch { throw new CanvasDocumentError("CANVAS_MEDIA_INVALID", "画布媒体地址无效"); }
        const match = /^\/api\/assets\/([^/]+)\/content\/?$/i.exec(path);
        if (match) {
            if (!uuidPattern.test(match[1]!)) throw new CanvasDocumentError("CANVAS_MEDIA_INVALID", "画布素材标识无效");
            ids.add(match[1]!.toLowerCase());
        }
    };
    const walk = (current: unknown, mediaContext = false, depth = 0): void => {
        if (depth > 100) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布数据嵌套过深");
        if (Array.isArray(current)) { for (const item of current) walk(item, mediaContext, depth + 1); return; }
        if (typeof current === "string") { if (mediaContext || /^\/api\/assets\/[^/]+\/content\/?$/i.test(current)) inspectMedia(current); return; }
        if (!current || typeof current !== "object") return;
        const object = current as Record<string, unknown>;
        const typedMedia = typeof object.type === "string" && /^(?:image|video|audio)(?:\/|$)/i.test(object.type);
        for (const [key, entry] of Object.entries(object)) {
            if (key === "storageKey" && entry != null && entry !== "") throw new CanvasDocumentError("CANVAS_LOCAL_MEDIA", "画布不能同步本地媒体存储键");
            if ((key === "assetId" || key === "serverAssetId") && typeof entry === "string" && entry) {
                if (!uuidPattern.test(entry)) throw new CanvasDocumentError("CANVAS_MEDIA_INVALID", "画布素材标识无效");
                ids.add(entry.toLowerCase());
            }
            const entryIsMedia = mediaField.test(key) || key === "references" || (key === "content" && (typedMedia || mediaContext));
            walk(entry, entryIsMedia || (key === "metadata" && typedMedia), depth + 1);
        }
    };
    walk(value);
    return [...ids];
}

export function parseCanvasDocumentWrite(id: unknown, body: unknown): { baseRevision: number; document: Record<string, unknown> | null; assetIds: string[] } {
    if (!idSchema.safeParse(id).success) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布标识无效");
    let serialized: string | undefined;
    try { serialized = JSON.stringify(body); }
    catch { throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布必须是有效的 JSON 数据"); }
    if (!serialized) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "缺少画布数据");
    if (Buffer.byteLength(serialized, "utf8") > CANVAS_DOCUMENT_MAX_BYTES) throw new CanvasDocumentError("CANVAS_DOCUMENT_TOO_LARGE", "画布数据超过 20 MB 限制", 413);
    const parsed = writeSchema.safeParse(body);
    if (!parsed.success) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布结构不完整或字段无效");
    const { baseRevision, document } = parsed.data;
    if (document && document.id !== id) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布标识与请求不一致");
    if (document) {
        const nodeIds = new Set(document.nodes.map(node => node.id));
        if (nodeIds.size !== document.nodes.length || new Set(document.connections.map(edge => edge.id)).size !== document.connections.length || new Set(document.chatSessions.map(chat => chat.id)).size !== document.chatSessions.length) {
            throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布中存在重复标识");
        }
        if (document.connections.some(edge => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))) throw new CanvasDocumentError("CANVAS_DOCUMENT_INVALID", "画布连线引用的节点不存在");
    }
    return { baseRevision, document, assetIds: collectMediaAssets(document) };
}

export function missingCanvasDocument(id: string): CanvasDocumentEnvelope {
    return { id, revision: 0, deleted: true, document: null, updatedAt: new Date(0).toISOString() };
}
