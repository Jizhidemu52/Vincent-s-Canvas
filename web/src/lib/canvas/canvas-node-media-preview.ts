type CanvasNodeMediaPreviewSource = {
    type: "image" | "video" | "audio" | "text" | "config";
    content?: string;
    storageKey?: string;
};

type CanvasNodeMediaPreviewResolvers = {
    resolveImage: (storageKey: string, fallback: string) => Promise<string>;
    resolveMedia: (storageKey: string, fallback: string) => Promise<string>;
};

/**
 * A backup can contain a local file plus an expired server or Blob URL.
 * Prefer the local file, resolving only when its virtualized node mounts;
 * the storage resolver keeps the original URL as a fallback if the file is missing.
 */
export function needsCanvasNodeMediaPreviewResolution(source: CanvasNodeMediaPreviewSource) {
    return Boolean(source.storageKey && (source.type === "image" || source.type === "video" || source.type === "audio"));
}

export async function resolveCanvasNodeMediaPreview(source: CanvasNodeMediaPreviewSource, resolvers: CanvasNodeMediaPreviewResolvers) {
    const fallback = source.content || "";
    if (!needsCanvasNodeMediaPreviewResolution(source)) return fallback;
    return source.type === "image" ? resolvers.resolveImage(source.storageKey!, fallback) : resolvers.resolveMedia(source.storageKey!, fallback);
}
