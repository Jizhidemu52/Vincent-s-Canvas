import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { createDedupedAsyncResolver } from "@/lib/deduped-async-resolver";
import { cacheObjectUrl, releaseObjectUrl, releaseUnusedObjectUrls } from "@/lib/object-url-cache";

export type UploadedImage = {
    originalFileName?: string;
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "wireless-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();
const loadObjectUrl = createDedupedAsyncResolver(async (storageKey: string) => {
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    cacheObjectUrl(objectUrls, storageKey, url);
    return url;
});

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    cacheObjectUrl(objectUrls, storageKey, url);
    const meta = await readImageMeta(url);
    return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType, ...(typeof File !== "undefined" && input instanceof File ? { originalFileName: input.name } : {}) };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    return (await loadObjectUrl(storageKey)) || fallback;
}

export async function getImageBlob(storageKey: string) {
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
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
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
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
