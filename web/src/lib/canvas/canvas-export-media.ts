const archivePrefix = "canvas-archive:";
const mediaFields = new Set(["url", "dataUrl", "src", "poster", "thumbnail", "coverUrl", "posterUrl", "thumbnailUrl", "previewUrl", "imageUrl", "videoUrl", "audioUrl", "resultUrl", "downloadUrl"]);
const referenceFields = new Set(["references", "referenceUrls", "manualImageReferences", "resultUrls", "sourceUrls"]);
type MediaRecord = Record<string, unknown>;

/** Only exact same-origin asset endpoints are files, never arbitrary prompt text or external URLs. */
function serverAssetPath(value: string, origin?: string) {
    let path = value;
    if (!value.startsWith("/api/assets/")) {
        if (!origin || !/^https?:\/\//i.test(value)) return null;
        let parsed: URL;
        try { parsed = new URL(value); } catch { return null; }
        if (parsed.origin !== origin || parsed.username || parsed.password) return null;
        path = parsed.pathname + parsed.search + parsed.hash;
    }
    const id = path.match(/^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/content(?:[?#].*)?$/i)?.[1];
    return id ? { id: id.toLowerCase(), path: `/api/assets/${id.toLowerCase()}/content` } : null;
}

/** Clone cloud documents into the existing storageKey + ZIP files format, without re-encoding bytes. */
export async function collectCanvasExportMedia<T>(document: T, options: {
    origin?: string;
    fetchBlob?: (path: string) => Promise<Blob>;
} = {}) {
    const blobs = new Map<string, Blob>();
    const requests = new Map<string, Promise<string>>();
    const origin = options.origin ?? (typeof window === "undefined" ? undefined : window.location.origin);
    const fetchBlob = options.fetchBlob ?? (async (path: string) => {
        const response = await fetch(path, { credentials: "include" });
        if (!response.ok) throw new Error(`画布素材导出失败（${response.status}），未生成不完整的备份`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("画布素材为空，未生成不完整的备份");
        return blob;
    });
    function download(url: string) {
        const asset = serverAssetPath(url, origin);
        if (!asset) return null;
        if (!requests.has(asset.path)) requests.set(asset.path, fetchBlob(asset.path).then(blob => {
            const kind = blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
            const key = `${kind}:archive-${asset.id}`;
            blobs.set(key, blob);
            return key;
        }));
        return requests.get(asset.path)!;
    }
    async function visit(value: unknown, mediaContext = false, field = ""): Promise<unknown> {
        if (Array.isArray(value)) return Promise.all(value.map(item => visit(item, mediaContext, field)));
        if (!value || typeof value !== "object") {
            if (typeof value !== "string" || !(mediaFields.has(field) || (mediaContext && (field === "content" || referenceFields.has(field))))) return value;
            const downloaded = download(value);
            return downloaded ? `${archivePrefix}${await downloaded}` : value;
        }
        const input = value as MediaRecord;
        const isMedia = mediaContext || typeof input.storageKey === "string" || /^(image|video|audio)(\/|$)/.test(String(input.type || input.kind || input.mediaType || input.mimeType)) || Boolean(input.referenceKey);
        const output: MediaRecord = {};
        for (const [name, child] of Object.entries(input)) {
            output[name] = await visit(child, name === "metadata" || name === "content" ? isMedia : referenceFields.has(name), name);
        }
        const primary = ["content", "url", "dataUrl", "src"].find(name => typeof output[name] === "string" && (output[name] as string).startsWith(archivePrefix));
        if (primary) output.storageKey = (output[primary] as string).slice(archivePrefix.length);
        return output;
    }
    return { document: await visit(document) as T, blobs };
}

/** Called after the existing ZIP importer writes files into browser storage. No network is needed. */
export function restoreCanvasExportMedia<T>(document: T, urls: ReadonlyMap<string, string>): T {
    function visit(value: unknown, mediaContext = false, field = ""): unknown {
        if (Array.isArray(value)) return value.map(item => visit(item, mediaContext, field));
        if (typeof value === "string" && value.startsWith(archivePrefix) && (mediaFields.has(field) || (mediaContext && (field === "content" || referenceFields.has(field))))) {
            const key = value.slice(archivePrefix.length);
            if (!urls.has(key)) throw new Error("画布备份缺少媒体文件，无法完整导入");
            // Image-edit reference lists already understand stable image storage keys across reloads.
            return referenceFields.has(field) && key.startsWith("image:") ? key : urls.get(key)!;
        }
        if (!value || typeof value !== "object") return value;
        const input = value as MediaRecord;
        const isMedia = mediaContext || typeof input.storageKey === "string" || /^(image|video|audio)(\/|$)/.test(String(input.type || input.kind || input.mediaType || input.mimeType)) || Boolean(input.referenceKey);
        const output = Object.fromEntries(Object.entries(input).map(([name, child]) => [name, visit(child, name === "metadata" || name === "content" ? isMedia : referenceFields.has(name), name)]));
        // An imported file is a new local source; its former employee's server ID is not permission to reuse that asset.
        if (typeof output.storageKey === "string" && urls.has(output.storageKey)) {
            delete output.serverAssetId;
            delete output.assetId;
        }
        return output;
    }
    return visit(document) as T;
}
