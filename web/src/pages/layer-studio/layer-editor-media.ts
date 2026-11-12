import type { LayerStudioItem } from "../../../../shared/layer-studio";
import { validLayerStudioSize, type LayerStudioImage } from "./layer-composition";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const MAX_CACHED_BYTES = 64 * 1024 * 1024;

export function layerStudioAssetPath(item: LayerStudioItem) {
    if (item.state !== "saved" || !item.assetId || !/^[a-zA-Z0-9_-]{1,200}$/.test(item.assetId)) throw new Error("图层原件尚未保存，暂不可下载");
    const path = `/api/assets/${item.assetId}/content`;
    if (item.contentUrl !== path) throw new Error("图层原件地址无效，请重新查询原任务；不会重新生成");
    return path;
}

export function layerStudioFileName(item: LayerStudioItem, mimeType: string) {
    const extension = mimeType.split(";")[0] === "image/jpeg" ? "jpg" : "png";
    const name = (item.name || (item.role === "base" ? "底图" : item.role === "image" ? "生成图片" : `图层-${item.urlIndex}`))
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || "图层原件";
    return `${String(item.index + 1).padStart(2, "0")}-${name}.${extension}`;
}

/** One immutable employee/task lifetime. No original is re-encoded or stored in a global cache. */
export function createLayerStudioMedia(options: {
    assertCurrent: () => void;
    headers: () => Record<string, string>;
    fetcher?: typeof fetch;
    createObjectUrl?: typeof URL.createObjectURL;
    revokeObjectUrl?: typeof URL.revokeObjectURL;
    cacheBytes?: number;
}) {
    const controller = new AbortController();
    const cache = new Map<string, Blob>();
    const requests = new Map<string, Promise<Blob>>();
    const objectUrls = new Map<string, ReturnType<typeof setTimeout> | null>();
    const createUrl = options.createObjectUrl || ((blob: Blob) => URL.createObjectURL(blob));
    const revokeUrl = options.revokeObjectUrl || ((url: string) => URL.revokeObjectURL(url));
    let cachedBytes = 0;
    const assertCurrent = () => { controller.signal.throwIfAborted(); options.assertCurrent(); };
    const releaseUrl = (url: string) => {
        if (!objectUrls.has(url)) return;
        const timer = objectUrls.get(url);
        if (timer) clearTimeout(timer);
        objectUrls.delete(url);
        revokeUrl(url);
    };
    const objectUrl = (blob: Blob) => { assertCurrent(); const url = createUrl(blob); objectUrls.set(url, null); return url; };
    const readOriginal = async (item: LayerStudioItem, signal?: AbortSignal): Promise<Blob> => {
        assertCurrent(); signal?.throwIfAborted();
        const path = layerStudioAssetPath(item), key = `${path}:${item.sha256 || ""}`;
        let blob = cache.get(key);
        if (blob) { cache.delete(key); cache.set(key, blob); return blob; }
        let request = requests.get(key);
        if (!request) {
            request = (async () => {
                const response = await (options.fetcher || fetch)(path, { credentials: "include", cache: "no-store", headers: options.headers(),
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
                assertCurrent();
                if (!response.ok) throw new Error(`图层原件读取失败（${response.status}），当前编辑已保留`);
                const result = await response.blob();
                assertCurrent();
                if (!result.size || !["image/png", "image/jpeg"].includes(result.type.split(";")[0])) throw new Error("图层原件不是有效的 PNG / JPEG，未导出或修改原件");
                if (item.sha256 !== undefined) {
                    if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error("图层原件校验记录无效");
                    const actual = bytesToHex(sha256(new Uint8Array(await result.arrayBuffer())));
                    assertCurrent();
                    if (actual !== item.sha256.toLowerCase()) throw new Error("图层原件校验不一致，未导出；当前编辑已保留");
                }
                const limit = options.cacheBytes ?? MAX_CACHED_BYTES;
                if (result.size <= limit) {
                    while (cachedBytes + result.size > limit && cache.size) {
                        const oldest = cache.keys().next().value!;
                        cachedBytes -= cache.get(oldest)!.size; cache.delete(oldest);
                    }
                    cache.set(key, result); cachedBytes += result.size;
                }
                return result;
            })().finally(() => { requests.delete(key); });
            requests.set(key, request);
        }
        blob = await request;
        assertCurrent(); signal?.throwIfAborted();
        return blob;
    };
    const readImage = async (item: LayerStudioItem, signal?: AbortSignal): Promise<LayerStudioImage> => {
        const blob = await readOriginal(item, signal);
        assertCurrent(); signal?.throwIfAborted();
        let image: ImageBitmap | HTMLImageElement;
        let release = () => {};
        if (typeof createImageBitmap === "function") {
            image = await createImageBitmap(blob);
            release = () => (image as ImageBitmap).close();
        } else {
            const url = objectUrl(blob);
            try {
                image = await new Promise<HTMLImageElement>((resolve, reject) => {
                    const element = new Image();
                    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
                    const finish = (error?: unknown) => {
                        clearTimeout(timeout); element.onload = null; element.onerror = null; combined.removeEventListener("abort", abort);
                        if (error) { element.src = ""; reject(error); } else resolve(element);
                    };
                    const abort = () => finish(combined.reason || new DOMException("图片读取已停止", "AbortError"));
                    const timeout = setTimeout(() => finish(new Error("图层图片解码超时")), 30_000);
                    element.onload = () => finish(); element.onerror = () => finish(new Error("图层图片无法解码"));
                    combined.addEventListener("abort", abort, { once: true }); element.src = url;
                    if (combined.aborted) abort();
                });
                release = () => { (image as HTMLImageElement).src = ""; releaseUrl(url); };
            } catch (error) { releaseUrl(url); throw error; }
        }
        try {
            assertCurrent(); signal?.throwIfAborted();
            const width = "naturalWidth" in image ? image.naturalWidth : image.width;
            const height = "naturalHeight" in image ? image.naturalHeight : image.height;
            if (!validLayerStudioSize({ width, height })) throw new Error("图层尺寸无效或超过安全画布范围");
            if ((item.width !== undefined && item.width !== width) || (item.height !== undefined && item.height !== height)) throw new Error("图层原件尺寸与保存记录不一致，当前编辑已保留");
            return { image, width, height, dispose: release };
        } catch (error) { release(); throw error; }
    };
    const download = (blob: Blob, fileName: string) => {
        assertCurrent();
        const url = objectUrl(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = fileName; anchor.hidden = true;
        document.body.append(anchor);
        try { assertCurrent(); anchor.click(); objectUrls.set(url, setTimeout(() => releaseUrl(url), 30_000)); }
        catch (error) { releaseUrl(url); throw error; }
        finally { anchor.remove(); }
    };
    return { readOriginal, readImage, download, assertCurrent,
        dispose() {
            controller.abort();
            for (const url of objectUrls.keys()) releaseUrl(url);
            cache.clear(); requests.clear(); cachedBytes = 0;
        },
    };
}
