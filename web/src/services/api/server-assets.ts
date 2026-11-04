import { generationPreSubmissionMessage } from "@/lib/generation-feedback";

export type AssetResultStatus = "unused" | "candidate" | "project" | "editing" | "downloaded" | "adopted" | "delivered" | "pending" | "rejected";
export type AssetEventType = "asset.candidate_added" | "asset.project_added" | "asset.edited" | "asset.reused" | "asset.downloaded" | "asset.exported" | "asset.adopted" | "asset.delivered" | "asset.pending" | "asset.rejected";
export type AssetProjection = { resultStatus: AssetResultStatus; usabilityScore: number; downloadCount: number; firstDownloadedAt: string | null; eventCount: number };
export type ServerAsset = {
    id: string;
    ownerUserId: string;
    ownerName: string;
    departmentId: string | null;
    departmentName: string | null;
    projectId: string | null;
    projectName: string | null;
    taskId: string | null;
    filename: string;
    mimeType: string;
    byteSize: number;
    kind: "image" | "video" | "text" | "other";
    source: string;
    operationType: string | null;
    prompt: string | null;
    canRecreate?: boolean;
    modelName: string | null;
    status: string;
    visibilityScope: "private" | "company";
    metadata: Record<string, unknown>;
    createdAt: string;
    deletedAt?: string | null;
    purgeAfter?: string | null;
    resultStatus: AssetResultStatus;
    usabilityScore: number;
    downloadCount: number;
    firstDownloadedAt: string | null;
    eventCount: number;
    contentUrl?: string | null;
    thumbnailUrl?: string | null;
    previewUrl?: string | null;
};
export type AssetListQuery = { limit?: number; cursor?: string; kind?: "image" | "video" | "text" | "other"; q?: string; projectId?: string; ownerUserId?: string; tag?: string; createdFrom?: string; createdBefore?: string; sort?: "newest" | "oldest" };
export type ServerAssetPage = { assets: ServerAsset[]; nextCursor: string | null; hasMore: boolean };
export type AssetBatchAction = "delete" | "download" | "add-to-canvas" | "move-project";
export type AssetBatchResult = { action: AssetBatchAction; assetIds: string[]; count: number; assets: ServerAsset[] };
export type ServerProject = { id: string; externalId: string; name: string; ownerName: string; departmentName: string | null; status: string; taskCount: number; assetCount: number; credits: number; updatedAt: string };
export type UserProject = { id: string; externalId: string; name: string; status: string; createdAt: string; updatedAt: string };
export type ServerAssetVariant = { assetId: string; url: string; mimeType: string; filename: string };
export type ServerAssetVariants = {
    primary: ServerAssetVariant;
    original: ServerAssetVariant;
    export?: ServerAssetVariant;
    maskComposited: boolean;
    warning?: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string; msg?: string; error?: string; code?: string };
        throw Object.assign(new Error(payload.msg || payload.message || "素材请求失败"), { status: response.status, code: payload.error || payload.code });
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export class ServerAssetContentError extends Error {
    constructor(readonly status: number, readonly code: "ASSET_OBJECT_MISSING" | "ASSET_STORAGE_UNAVAILABLE") {
        super(generationPreSubmissionMessage(code) || "参考素材原文件暂时无法核验，请稍后重试或联系管理员；尚未提交生成。");
        this.name = "ServerAssetContentError";
    }
}

/** A ready row is not proof of an object. Only the server's exact missing-object code permits repair. */
export async function assertServerAssetContent(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let response: Response;
    try {
        response = await fetch(`/api/assets/${encodeURIComponent(id)}/content`, { method: "HEAD", credentials: "include", cache: "no-store", signal });
    } catch (error) {
        signal?.throwIfAborted();
        throw new ServerAssetContentError(0, "ASSET_STORAGE_UNAVAILABLE");
    }
    signal?.throwIfAborted();
    if (response.ok) return;
    throw new ServerAssetContentError(response.status, response.status === 404 && response.headers.get("X-Canvas-Asset-Error") === "ASSET_OBJECT_MISSING" ? "ASSET_OBJECT_MISSING" : "ASSET_STORAGE_UNAVAILABLE");
}

function assetListUrl(path: string, query: AssetListQuery) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    return params.size ? `${path}?${params}` : path;
}
export const listServerAssets = (queryOrSignal: AssetListQuery | AbortSignal = {}, signal?: AbortSignal) => {
    const isSignal = "aborted" in queryOrSignal;
    return request<ServerAssetPage>(assetListUrl("/api/assets", isSignal ? {} : queryOrSignal), { signal: isSignal ? queryOrSignal : signal });
};
export const listAdminServerAssets = (query: AssetListQuery = {}, signal?: AbortSignal) => request<ServerAssetPage>(assetListUrl("/api/admin/assets", query), { signal });
export const listDeletedServerAssets = (query: AssetListQuery = {}, signal?: AbortSignal) => request<ServerAssetPage>(assetListUrl("/api/assets/trash", query), { signal });
export const restoreServerAsset = (id: string) => request<void>(`/api/assets/${encodeURIComponent(id)}/restore`, { method: "POST" });
export const listAdminAssetOwners = (signal?: AbortSignal) => request<{ owners: Array<{ value: string; label: string }> }>("/api/admin/assets/owners", { signal });
export const fetchServerAsset = (id: string, signal?: AbortSignal) => request<{ asset: ServerAsset }>(`/api/assets/${encodeURIComponent(id)}`, { signal });
export const getServerAssetOverview = () => request<ServerAssetPage & { total: number }>("/api/assets/summary");
export const batchServerAssets = (action: AssetBatchAction, assetIds: string[], projectId?: string) =>
    request<AssetBatchResult>("/api/assets/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, assetIds, projectId }) });
export const listAdminServerProjects = () => request<{ projects: ServerProject[] }>("/api/admin/projects");
export const listServerProjects = (signal?: AbortSignal) => request<{ projects: UserProject[] }>("/api/projects", { signal });

export async function fetchServerAssetVariants(id: string, signal?: AbortSignal): Promise<ServerAssetVariants> {
    const payload = await request<ServerAssetVariants | { code: number; data: ServerAssetVariants; msg: string }>(`/api/assets/${encodeURIComponent(id)}/variants`, { signal });
    if ("code" in payload) {
        if (payload.code !== 0) throw new Error(payload.msg || "图片版本读取失败");
        return payload.data;
    }
    return payload;
}

export async function uploadServerAsset(file: File, metadata: Record<string, unknown> = {}, options: { projectId?: string; clientReferenceId?: string; repairAssetId?: string; expectedOwnerId?: string; signal?: AbortSignal } = {}) {
    const { expectedOwnerId, signal, ...bodyOptions } = options;
    const ownerHeaders: Record<string, string> = expectedOwnerId ? { "X-Canvas-Owner-Id": expectedOwnerId } : {};
    signal?.throwIfAborted();
    const created = await request<{ assetId: string; uploadUrl: string | null; reused?: boolean }>("/api/assets/upload-request", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...ownerHeaders },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size, kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("text/") ? "text" : "other", metadata, ...bodyOptions }),
    });
    signal?.throwIfAborted();
    if (options.repairAssetId && created.assetId !== options.repairAssetId) throw new ServerAssetContentError(409, "ASSET_OBJECT_MISSING");
    if (created.uploadUrl) await request<void>(created.uploadUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream", ...ownerHeaders }, body: file, signal });
    signal?.throwIfAborted();
    if (!created.uploadUrl || created.reused || options.repairAssetId) await assertServerAssetContent(created.assetId, signal);
    return created.assetId;
}

export async function fetchServerAssetContent(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/assets/${id}/content`, { credentials: "include", signal });
    if (!response.ok) throw new Error(`素材下载失败（${response.status}）`);
    return response.blob();
}

export type ServerAssetPoster = { status: "pending"; retryAfterMs: number } | { status: "ready"; blob: Blob; durationMs?: number };
export type ServerImageThumbnail = { status: "pending"; retryAfterMs: number } | { status: "ready"; blob: Blob };
export async function fetchServerImageThumbnail(url: string, signal: AbortSignal): Promise<ServerImageThumbnail> {
    if (!/^\/api\/assets\/[0-9a-f-]{36}\/thumb\?w=(256|1024)$/i.test(url)) throw new Error("图片预览地址无效");
    const response = await fetch(`${url}&pending=1`, { credentials: "include", signal, cache: "no-store" });
    if (response.status === 202) {
        const seconds = Number(response.headers.get("Retry-After"));
        return { status: "pending", retryAfterMs: Math.max(1000, Math.min(10_000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 3) * 1000)) };
    }
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/")) throw new Error(`图片预览暂时不可用（${response.status}）`);
    const blob = await response.blob();
    if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error("图片预览格式无效");
    return { status: "ready", blob };
}
export async function fetchServerAssetPoster(id: string, signal?: AbortSignal): Promise<ServerAssetPoster> {
    const response = await fetch(`/api/assets/${encodeURIComponent(id)}/thumb?w=256`, { credentials: "include", signal });
    if (response.status === 202) {
        const seconds = Number(response.headers.get("Retry-After"));
        return { status: "pending", retryAfterMs: Math.max(1000, Math.min(10_000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 3) * 1000)) };
    }
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/")) throw new Error("视频封面暂时不可用，仍可播放原视频");
    const blob = await response.blob();
    if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error("视频封面格式无效");
    const durationMs = Number(response.headers.get("X-Canvas-Media-Duration-Ms"));
    return { status: "ready", blob, ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs } : {}) };
}

export const recordServerAssetEvent = (id: string, eventType: AssetEventType, metadata: Record<string, unknown> = {}, projectId?: string) =>
    request<{ eventId: string; projection: AssetProjection }>(`/api/assets/${id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType, idempotencyKey: `${eventType}:${id}:${createClientId()}`, metadata, projectId }),
    });

export const recordServerAssetDownload = (id: string, filename: string, idempotencyKey: string) =>
    request<{ eventId: string; projection: AssetProjection }>(`/api/assets/${id}/download-receipts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey, filename }),
    });

export const setServerAssetVisibility = (id: string, visibility: "private" | "company") =>
    request<void>(`/api/assets/${id}/visibility`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }) });

export const shareServerAssetWithDepartment = (id: string, departmentId: string) =>
    request<void>(`/api/assets/${id}/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "department", targetId: departmentId }) });

export const unshareServerAssetWithDepartment = (id: string, departmentId: string) =>
    request<void>(`/api/assets/${id}/share`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "department", targetId: departmentId }) });

export const deleteServerAsset = (id: string) => request<void>(`/api/assets/${id}`, { method: "DELETE" });
export const updateServerAssetMetadata = (id: string, input: { title: string; tags: string[]; source: string; note: string }) =>
    request<void>(`/api/assets/${id}/metadata`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
import { createClientId } from "@/lib/client-id";
