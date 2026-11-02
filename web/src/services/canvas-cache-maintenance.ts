import { verifiedCacheCandidates, evictVerifiedCanvasImages } from "@/lib/canvas/canvas-verified-cache";
import { readMediaSource, readUploadedMedia, rememberMediaSource } from "./canvas-media-links";
import { getImageBlob, evictStoredImageCache } from "./image-storage";

/** Explicit user action only. Never run as an automatic cleanup or on the trial workspace. */
export async function cleanupVerifiedCanvasCache() {
    const [{ canvasCacheMaintenanceContext }, { useAssetStore }] = await Promise.all([import("@/stores/canvas/use-canvas-store"), import("@/stores/use-asset-store")]);
    const context = await canvasCacheMaintenanceContext();
    const assets = useAssetStore.getState().assets;
    return evictVerifiedCanvasImages(verifiedCacheCandidates(context.projects, context.synchronized, assets), {
        current: () => context.isCurrent() && useAssetStore.getState().assets === assets,
        local: getImageBlob,
        source: async key => await readMediaSource(key) || await readUploadedMedia(context.ownerId, key),
        remote: async url => {
            const response = await fetch(url, { credentials: "include", headers: { "X-Canvas-Owner-Id": context.ownerId }, signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error("云端原件无法验证，跳过缓存");
            return response.blob();
        },
        remember: rememberMediaSource,
        evict: evictStoredImageCache,
    });
}
