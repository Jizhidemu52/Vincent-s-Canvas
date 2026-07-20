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
    modelName: string | null;
    status: string;
    visibilityScope: "private" | "company";
    metadata: Record<string, unknown>;
    createdAt: string;
    resultStatus: AssetResultStatus;
    usabilityScore: number;
    downloadCount: number;
    firstDownloadedAt: string | null;
    eventCount: number;
};
export type ServerProject = { id: string; externalId: string; name: string; ownerName: string; departmentName: string | null; status: string; taskCount: number; assetCount: number; credits: number; updatedAt: string };
export type UserProject = { id: string; externalId: string; name: string; status: string; createdAt: string; updatedAt: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, credentials: "include" });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message || "素材请求失败");
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export const listServerAssets = () => request<{ assets: ServerAsset[] }>("/api/assets");
export const listAdminServerAssets = () => request<{ assets: ServerAsset[] }>("/api/admin/assets");
export const listAdminServerProjects = () => request<{ projects: ServerProject[] }>("/api/admin/projects");
export const listServerProjects = () => request<{ projects: UserProject[] }>("/api/projects");

export async function uploadServerAsset(file: File, metadata: Record<string, unknown> = {}, options: { projectId?: string; clientReferenceId?: string } = {}) {
    const created = await request<{ assetId: string; uploadUrl: string | null }>("/api/assets/upload-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || "application/octet-stream", byteSize: file.size, kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("text/") ? "text" : "other", metadata, ...options }),
    });
    if (created.uploadUrl) await request<void>(created.uploadUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    return created.assetId;
}

export async function fetchServerAssetContent(id: string) {
    const response = await fetch(`/api/assets/${id}/content`, { credentials: "include" });
    if (!response.ok) throw new Error(`素材下载失败（${response.status}）`);
    return response.blob();
}

export const recordServerAssetEvent = (id: string, eventType: AssetEventType, metadata: Record<string, unknown> = {}, projectId?: string) =>
    request<{ eventId: string; projection: AssetProjection }>(`/api/assets/${id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType, idempotencyKey: `${eventType}:${id}:${crypto.randomUUID()}`, metadata, projectId }),
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
