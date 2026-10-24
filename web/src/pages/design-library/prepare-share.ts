import { createClientId } from "@/lib/client-id";
import { requireDesignLibraryOwner } from "@/services/api/design-library";
import { fetchServerAsset, uploadServerAsset, type ServerAsset } from "@/services/api/server-assets";
import { readMediaSource, readUploadedMedia, rememberUploadedMedia, serverMediaId } from "@/services/canvas-media-links";
import { resolveImageUrl } from "@/services/image-storage";
import type { DesignLibraryShareDraft, DesignLibraryShareSource } from "./share-draft";

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
function assertShareable(asset: ServerAsset, owner: string) {
    if (asset.ownerUserId !== owner || asset.kind !== "image" || asset.status !== "ready" || asset.deletedAt) throw new Error("只能分享本人仍可访问的图片素材");
    if (!extensions[asset.mimeType] || !asset.byteSize || asset.byteSize > 20 * 1024 * 1024) throw new Error("请选择不超过 20 MB 的 PNG、JPG、WebP 或 GIF 原图");
}

export async function prepareDesignLibraryShareDraft(source: DesignLibraryShareSource, signal: AbortSignal): Promise<{ draft: DesignLibraryShareDraft; savedPrivateCopy: boolean }> {
    const assertCurrent = () => { signal.throwIfAborted(); requireDesignLibraryOwner(false, source.ownerId); };
    assertCurrent();
    let assetId = source.assetId || serverMediaId(source.dataUrl || "");
    if (!assetId && source.storageKey) { assetId = serverMediaId(await readMediaSource(source.storageKey) || ""); assertCurrent(); }
    if (!assetId && source.storageKey) { assetId = serverMediaId(await readUploadedMedia(source.ownerId, source.storageKey) || ""); assertCurrent(); }
    let savedPrivateCopy = false;
    if (!assetId) {
        const url = await resolveImageUrl(source.storageKey, source.dataUrl || ""); assertCurrent();
        if (!url) throw new Error("原图暂不可读取，请先保存到我的素材后再分享");
        const response = await fetch(url, { signal }); assertCurrent();
        if (!response.ok) throw new Error(`原图读取失败（${response.status}），尚未创建分享`);
        const blob = await response.blob(); assertCurrent();
        const extension = extensions[blob.type.toLowerCase().split(";")[0].trim()];
        if (!extension || !blob.size || blob.size > 20 * 1024 * 1024) throw new Error("请选择不超过 20 MB 的 PNG、JPG、WebP 或 GIF 原图");
        const filename = source.filename || `${source.title || "设计原图"}.${extension}`;
        assetId = await uploadServerAsset(new File([blob], filename, { type: blob.type }), {
            source: "design-library-draft", title: source.title, prompt: source.prompt || "", model: source.model || "", tags: source.tags || [],
        }, { expectedOwnerId: source.ownerId, clientReferenceId: source.storageKey ? `canvas:${source.storageKey}` : `library-draft:${createClientId()}`, signal });
        assertCurrent(); savedPrivateCopy = true;
        if (source.storageKey) { await rememberUploadedMedia(source.ownerId, source.storageKey, `/api/assets/${assetId}/content`); assertCurrent(); }
    }
    const { asset } = await fetchServerAsset(assetId, signal); assertCurrent(); assertShareable(asset, source.ownerId);
    return { savedPrivateCopy, draft: { ownerId: source.ownerId, asset, title: source.title.slice(0, 120),
        thought: source.thought || "", prompt: source.prompt || "", tags: source.tags || [], model: source.model || "" } };
}
