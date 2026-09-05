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
 * Persisted browser Blob URLs are invalid after a refresh. Resolve them only
 * when their virtualized canvas node actually enters the DOM.
 */
export function needsCanvasNodeMediaPreviewResolution(source: CanvasNodeMediaPreviewSource) {
    if (!source.storageKey || (source.type !== "image" && source.type !== "video" && source.type !== "audio")) return false;
    return !source.content || source.content.startsWith("blob:");
}

export async function resolveCanvasNodeMediaPreview(source: CanvasNodeMediaPreviewSource, resolvers: CanvasNodeMediaPreviewResolvers) {
    const fallback = source.content || "";
    if (!needsCanvasNodeMediaPreviewResolution(source)) return fallback;
    return source.type === "image" ? resolvers.resolveImage(source.storageKey!, fallback) : resolvers.resolveMedia(source.storageKey!, fallback);
}
