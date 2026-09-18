import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { createImageThumbnailCache, type ImageThumbnailRequest } from "@/lib/image-thumbnail-cache";
import { imageThumbnailSize } from "@/lib/canvas/canvas-image-thumbnail";

// Disposable, employee-scoped derivatives. Originals remain in image_files.
const thumbnails = createWorkspaceStorage("image_thumbnails");
const originals = createWorkspaceStorage("image_files");
const indexKey = "thumbnail:index:v1";
const maxCachedThumbnails = 128;
let cacheIndex: Promise<string[]> | undefined;
const readIndex = () => cacheIndex ||= thumbnails.getItem<string[]>(indexKey).then((keys) => keys || []).catch(() => []);

async function saveThumbnail(key: string, blob: Blob) {
    // Queue serialization makes this small bounded index sufficient; no database scan.
    const keys = await readIndex();
    const previous = keys.indexOf(key);
    if (previous >= 0) keys.splice(previous, 1);
    await thumbnails.setItem(key, blob);
    keys.push(key);
    while (keys.length > maxCachedThumbnails) await thumbnails.removeItem(keys.shift()!);
    await thumbnails.setItem(indexKey, keys);
}

async function generateThumbnail(request: ImageThumbnailRequest) {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const blob = await originals.getItem<Blob>(request.storageKey);
    if (!blob || !/^image\/(png|jpeg|webp|avif|bmp)$/.test(blob.type)) return null;
    const size = imageThumbnailSize(request.width, request.height, request.edge);
    const bitmap = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
    try {
        if (!thumbnails.isCurrent()) return null;
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    } finally { bitmap.close(); }
}

const cache = createImageThumbnailCache({
    isCurrent: thumbnails.isCurrent,
    read: (key) => thumbnails.getItem<Blob>(key),
    write: saveThumbnail,
    remove: (key) => thumbnails.removeItem(key),
    generate: generateThumbnail,
    schedule: (run) => {
        if (typeof window !== "undefined" && "requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 750 });
        else setTimeout(run, 16);
    },
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
});

export const acquireImageThumbnail = cache.acquire;
export const invalidateImageThumbnails = cache.invalidate;

if (typeof window !== "undefined") window.addEventListener("pagehide", cache.releaseAll);
