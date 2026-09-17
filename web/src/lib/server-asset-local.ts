import type { Asset } from "@/stores/use-asset-store";
import type { ServerAsset } from "@/services/api/server-assets";

export function isSupportedServerAsset(asset: ServerAsset) {
    return asset.kind === "image" || asset.kind === "video" || asset.kind === "text";
}

/** Server URLs are already durable references, not browser-local storage keys. */
export function serverAssetToLocal(asset: ServerAsset): Asset {
    if (!isSupportedServerAsset(asset)) throw new Error("此素材类型暂不支持展示");
    const { storageKey: _localStorageKey, ...metadata } = asset.metadata;
    const title = typeof metadata.title === "string" ? metadata.title : asset.filename;
    const common = { id: asset.id, ownerId: asset.ownerUserId, title, coverUrl: `/api/assets/${asset.id}/content`, tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [], source: typeof metadata.source === "string" ? metadata.source : asset.source, note: typeof metadata.note === "string" ? metadata.note : undefined, metadata: { ...metadata, serverAssetId: asset.id, designerId: asset.ownerUserId, departmentId: asset.departmentId, projectId: asset.projectId, operationType: asset.operationType, module: typeof metadata.module === "string" ? metadata.module : asset.operationType, prompt: asset.prompt, model: typeof metadata.model === "string" ? metadata.model : asset.modelName, modelName: asset.modelName, resultStatus: asset.resultStatus, usabilityScore: asset.usabilityScore, downloadCount: asset.downloadCount, visibilityScope: asset.visibilityScope, firstDownloadedAt: asset.firstDownloadedAt }, createdAt: asset.createdAt, updatedAt: asset.createdAt };
    if (asset.kind === "text") return { ...common, kind: "text", data: { content: typeof metadata.content === "string" ? metadata.content : "" } };
    const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    const dimensions = { width: dimension(metadata.width) || dimension(metadata.naturalWidth), height: dimension(metadata.height) || dimension(metadata.naturalHeight), bytes: asset.byteSize, mimeType: asset.mimeType };
    if (asset.kind === "video") return { ...common, kind: "video", data: { url: common.coverUrl, ...dimensions } };
    return { ...common, kind: "image", data: { dataUrl: common.coverUrl, ...dimensions } };
}
