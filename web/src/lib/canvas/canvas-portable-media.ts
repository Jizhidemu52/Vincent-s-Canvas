type MediaObject = Record<string, unknown>;
export type PortableMediaResolver = (input: { storageKey?: string; url: string; mimeType?: string; name?: string }) => Promise<string>;
const mediaFields = new Set(["url", "dataUrl", "src", "poster", "thumbnail", "coverUrl", "posterUrl", "thumbnailUrl", "previewUrl", "imageUrl", "videoUrl", "audioUrl", "resultUrl", "downloadUrl"]);
const needsUpload = (url: string) => /^(blob:|data:(image|video|audio)\/|https?:\/\/)/i.test(url);

/** Copy the full document, including undo snapshots and chat attachments. Never re-encode image bytes. */
export async function portableCanvasMedia<T>(document: T, resolve: PortableMediaResolver): Promise<T> {
    const resolved = new Map<string, Promise<string>>();
    async function visit(value: unknown, mediaContext = false, field = ""): Promise<unknown> {
        if (Array.isArray(value)) return Promise.all(value.map(item => visit(item, mediaContext, field)));
        if (!value || typeof value !== "object") {
            if (typeof value === "string" && mediaContext && field === "references" && /^(image|video|audio|file|media):/.test(value)) return resolveOnce({ storageKey: value, url: "" });
            if (typeof value === "string" && (mediaFields.has(field) || (mediaContext && ["content", "references"].includes(field))) && needsUpload(value)) return resolveOnce({ url: value });
            return value;
        }
        const input = value as MediaObject;
        const key = typeof input.storageKey === "string" ? input.storageKey : undefined;
        const isMedia = mediaContext || Boolean(key) || /^(image|video|audio)(\/|$)/.test(String(input.type)) || Boolean(input.referenceKey);
        const output: MediaObject = {};
        for (const [name, child] of Object.entries(input)) {
            if (name === "storageKey") continue;
            const isUrl = mediaFields.has(name) || (name === "content" && isMedia);
            const primaryKey = ["content", "url", "dataUrl", "src"].includes(name) ? key : undefined;
            if (isUrl && typeof child === "string" && (primaryKey || needsUpload(child))) {
                output[name] = await resolveOnce({ storageKey: primaryKey, url: child, mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined, name: typeof input.originalFileName === "string" ? input.originalFileName : undefined });
            } else output[name] = await visit(child, name === "metadata" ? isMedia : name === "references" || name === "manualImageReferences", name);
        }
        if (key && !["content", "url", "dataUrl", "src"].some(name => typeof input[name] === "string")) {
            const name = field === "references" || field === "images" ? "dataUrl" : field === "metadata" || field === "manualImageReferences" ? "content" : "url";
            output[name] = await resolveOnce({ storageKey: key, url: "", mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined });
        }
        return output;
    }
    function resolveOnce(input: Parameters<PortableMediaResolver>[0]) {
        const key = input.storageKey || input.url;
        if (!resolved.has(key)) resolved.set(key, resolve(input));
        return resolved.get(key)!;
    }
    return await visit(document) as T;
}
