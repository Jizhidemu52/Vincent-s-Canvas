import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { forgetMediaSource, rememberMediaSource } from "./canvas-media-links";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { createDedupedAsyncResolver } from "@/lib/deduped-async-resolver";
import { cacheObjectUrl, releaseObjectUrl, releaseUnusedObjectUrls } from "@/lib/object-url-cache";
import { invalidateImageThumbnails } from "./image-thumbnails";

export type UploadedImage = {
    originalFileName?: string;
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = createWorkspaceStorage("image_files");
const objectUrls = new Map<string, string>();
const loadObjectUrl = createDedupedAsyncResolver(async (storageKey: string) => {
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    cacheObjectUrl(objectUrls, storageKey, url);
    return url;
});

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    store.assertAccess();
    let blob: Blob;
    if (typeof input === "string") {
        const response = await fetch(input);
        if (!response.ok) throw new Error(`图片读取失败（${response.status}），请重新添加图片`);
        blob = await response.blob();
    } else {
        blob = input;
    }
    if (!blob.size) throw new Error("图片文件为空，请重新选择图片");
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    let storageAttempted = false;
    let sourceAttempted = false;
    try {
        // Validate before writing: keep the original bytes, not a re-encoded copy.
        const meta = await readImageMeta(url);
        storageAttempted = true;
        await store.setItem(storageKey, blob);
        if (typeof input === "string") {
            sourceAttempted = true;
            await rememberMediaSource(storageKey, input);
        }
        cacheObjectUrl(objectUrls, storageKey, url);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType, ...(typeof File !== "undefined" && input instanceof File ? { originalFileName: input.name } : {}) };
    } catch (error) {
        URL.revokeObjectURL(url);
        const cleanup = await Promise.allSettled([
            ...(storageAttempted ? [store.removeItem(storageKey)] : []),
            ...(sourceAttempted ? [forgetMediaSource(storageKey)] : []),
        ]);
        if (cleanup.some((result) => result.status === "rejected")) {
            throw new Error(`${error instanceof Error ? error.message : "保存图片失败"}；本地临时数据清理失败，请重新打开工作区后重试`, { cause: error });
        }
        throw error;
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    store.assertIdentity();
    if (!storageKey) return fallback;
    store.assertAccess();
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    return (await loadObjectUrl(storageKey)) || fallback;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    await invalidateImageThumbnails(storageKey);
    const url = URL.createObjectURL(blob);
    cacheObjectUrl(objectUrls, storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, resolveUrl = resolveImageUrl) {
    // Persisted files are authoritative: dataUrl may be an object URL from an earlier page load.
    const url = await resolveUrl(image.storageKey, image.dataUrl || image.url || "");
    if (!url || url.startsWith("data:")) return url;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`参考图读取失败（${response.status}），请重新添加图片`);
    return blobToDataUrl(await response.blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            releaseObjectUrl(objectUrls, key);
            await store.removeItem(key);
            await invalidateImageThumbnails(key);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown, protectedKeys: Iterable<string> = [], assertCleanup?: () => void) {
    assertCleanup?.();
    const usedKeys = collectImageStorageKeys(usedData);
    for (const key of protectedKeys) usedKeys.add(key);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    assertCleanup?.();
    await deleteStoredImages(unused);
}

/** Release image object URLs not visible in the current workspace without deleting local files. */
export function releaseUnusedImageObjectUrls(usedData: unknown) {
    releaseUnusedObjectUrls(objectUrls, collectImageStorageKeys(usedData));
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
