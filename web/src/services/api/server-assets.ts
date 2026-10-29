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
        const payload = (await response.json().catch(() => ({}))) as { message?: string; msg?: string };
        throw new Error(payload.msg || payload.message || "素材请求失败");
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
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

export async function uploadServerAsset(file: File, metadata: Record<string, unknown> = {}, options: { projectId?: string; clientReferenceId?: string; expectedOwnerId?: string; signal?: AbortSignal } = {}) {
    const { expectedOwnerId, signal, ...bodyOptions } = options;
    const ownerHeaders: Record<string, string> = expectedOwnerId ? { "X-Canvas-Owner-Id": expectedOwnerId } : {};
    const created = await request<{ assetId: string; uploadUrl: string | null }>("/api/assets/upload-request", {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...ownerHeaders },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size, kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("text/") ? "text" : "other", metadata, ...bodyOptions }),
    });
    if (created.uploadUrl) await request<void>(created.uploadUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream", ...ownerHeaders }, body: file, signal });
    return created.assetId;
}

export async function fetchServerAssetContent(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/assets/${id}/content`, { credentials: "include", signal });
    if (!response.ok) throw new Error(`素材下载失败（${response.status}）`);
    return response.blob();
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
