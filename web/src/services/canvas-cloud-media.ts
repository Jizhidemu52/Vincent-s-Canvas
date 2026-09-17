import { getImageBlob } from "./image-storage";
import { getMediaBlob } from "./file-storage";
import { uploadServerAsset } from "./api/server-assets";
import { readMediaSource, readUploadedMedia, rememberUploadedMedia, serverMediaId } from "./canvas-media-links";
import { portableCanvasMedia, type PortableMediaResolver } from "@/lib/canvas/canvas-portable-media";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const inFlight = new Map<string, Promise<string>>();
export function ensureCloudMedia(owner: string, input: Parameters<PortableMediaResolver>[0], metadata: Record<string, unknown> = {}) {
    const key = input.storageKey || input.url;
    const flightKey = JSON.stringify([owner, key]);
    const existing = inFlight.get(flightKey);
    if (existing) return existing;
    const pending = (async () => {
        if (serverMediaId(input.url) && !input.storageKey) return input.url;
        const source = input.storageKey ? await readMediaSource(input.storageKey) : null;
        if (source) return source;
        const cached = await readUploadedMedia(owner, key);
        if (cached) return cached;
        let blob = input.storageKey ? await (input.storageKey.startsWith("image:") ? getImageBlob(input.storageKey) : getMediaBlob(input.storageKey)) : null;
        if (!blob) {
            if (!input.url) throw new Error("画布媒体文件缺失，请保留本机原稿并重新添加该文件");
            const response = await fetch(input.url, { credentials: "include" });
            if (!response.ok) throw new Error(`画布媒体读取失败（${response.status}）`);
            blob = await response.blob();
        }
        const mime = blob.type || input.mimeType || "application/octet-stream";
        const file = new File([blob], input.name || `canvas-media.${mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("video") ? "mp4" : "bin"}`, { type: mime });
        // Local storage keys are immutable and reused by assets, current nodes and undo snapshots.
        const id = await uploadServerAsset(file, metadata, { expectedOwnerId: owner, ...(input.storageKey ? { clientReferenceId: `canvas:${input.storageKey}` } : {}) });
        const url = `/api/assets/${id}/content`;
        await rememberUploadedMedia(owner, key, url);
        return url;
    })().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, pending);
    return pending;
}
export function makeCloudCanvas(owner: string, project: CanvasProject) {
    return portableCanvasMedia(project, input => ensureCloudMedia(owner, input, { projectId: project.id, projectName: project.title, source: "canvas" }));
}
