import { EXTERNAL_IMAGE_UNAVAILABLE, type ImageDropSnapshot } from "./dropped-images";
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;
const MAX_DROP_FILES = 20;
function imageMime(bytes: Uint8Array) {
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
    if (bytes[0] === 0x89 && ascii(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
    if (ascii(0, 2) === "BM") return "image/bmp";
    if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
    return undefined;
}

/** WeCom/Windows virtual files may have no MIME or filename extension. Keep every byte. */
export async function normalizeDroppedFile(file: File) {
    if (file.type && file.type !== "application/octet-stream") return file;
    const type = imageMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    return type ? new File([file], file.name || "拖入图片", { type, lastModified: file.lastModified }) : file;
}

function permittedImageUrl(value: string, origin: string) {
    if (/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/i.test(value)) {
        if (value.length > MAX_REMOTE_BYTES * 1.4) throw new Error("拖入图片超过 20 MB，请先保存到本机后按页面限制上传。");
        return new URL(value);
    }
    const url = new URL(value, origin);
    if (url.username || url.password) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    if (url.protocol === "blob:" && url.origin === origin) return url;
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    if (url.origin === origin) return url;
    const host = url.hostname.toLowerCase();
    // No credential forwarding or cross-origin LAN fetching for untrusted drag text.
    if (!host.includes(".") || host === "localhost" || /\.(?:local|localhost|internal)$/.test(host)
        || host.includes(":") || /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(host)) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    return url;
}

async function readImageUrl(value: string, origin: string, signal: AbortSignal, fetcher: typeof fetch) {
    const url = permittedImageUrl(value, origin);
    const response = await fetcher(url.href, { signal, credentials: url.origin === origin ? "same-origin" : "omit", referrerPolicy: "no-referrer", mode: "cors", redirect: "error" });
    if (!response.ok || !response.body) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_REMOTE_BYTES) {
        await response.body.cancel();
        throw new Error("拖入图片超过 20 MB，请先保存到本机后按页面限制上传。");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const item = await reader.read();
            if (item.done) break;
            size += item.value.length;
            if (size > MAX_REMOTE_BYTES) throw new Error("拖入图片超过 20 MB，请先保存到本机后按页面限制上传。");
            chunks.push(item.value);
        }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const blob = new Blob(chunks as BlobPart[]);
    const type = imageMime(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (!type) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    const extension = type.split("/")[1]!.replace("jpeg", "jpg");
    return new File([blob], `拖入图片.${extension}`, { type });
}

export async function readImageDrop(snapshot: ImageDropSnapshot, options: { signal?: AbortSignal; origin?: string; fetcher?: typeof fetch; allowNonImages?: boolean } = {}) {
    if (snapshot.files.length > MAX_DROP_FILES || snapshot.urls.length > MAX_DROP_FILES) throw new Error("一次最多拖入 20 个文件，请分批添加。");
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    signal.throwIfAborted();
    const files: File[] = [];
    for (const file of snapshot.files) {
        signal.throwIfAborted();
        files.push(await normalizeDroppedFile(file));
    }
    if (!files.length) for (const url of snapshot.urls) files.push(await readImageUrl(url, options.origin || window.location.origin, signal, options.fetcher || fetch));
    signal.throwIfAborted();
    const accepted = options.allowNonImages ? files : files.filter(file => file.type.startsWith("image/"));
    if (!accepted.length) throw new Error(EXTERNAL_IMAGE_UNAVAILABLE);
    return { files: accepted, skipped: files.length - accepted.length };
}
