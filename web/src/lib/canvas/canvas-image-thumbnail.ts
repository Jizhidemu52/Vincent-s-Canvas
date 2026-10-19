import type { CanvasNodeData } from "@/types/canvas";

export const imageThumbnailEdges = [256, 512, 1024] as const;
export type ImageThumbnailEdge = (typeof imageThumbnailEdges)[number];

/** Stable preview tiers avoid resampling every time a wheel gesture settles. */
export function canvasPreviewScaleBucket(scale: number) {
    if (!Number.isFinite(scale) || scale > 2) return Number.POSITIVE_INFINITY;
    return scale <= 0.5 ? 0.5 : scale <= 1 ? 1 : 2;
}

export function canvasServerThumbnailUrl(content: string, edge: ImageThumbnailEdge | 0) {
    if (!edge) return null;
    const match = /^(\/api\/assets\/[0-9a-f-]{36})\/content(?:\?.*)?$/i.exec(content);
    return match ? `${match[1]}/thumb?w=${edge <= 256 ? 256 : 1024}` : null;
}

/** 0 means original. Never enlarge a small source or soften a near-native view. */
export function canvasImagePreviewEdge(node: CanvasNodeData, scale: number, dpr = 1): ImageThumbnailEdge | 0 {
    if (node.type !== "image") return 0;
    const serverImage = canvasServerThumbnailUrl(node.metadata?.content || "", 256);
    if (!node.metadata?.storageKey && !serverImage) return 0;
    const width = node.metadata?.naturalWidth || 0;
    const height = node.metadata?.naturalHeight || 0;
    const longest = Math.max(width, height);
    const previewScale = canvasPreviewScaleBucket(scale);
    if ((!width || !height) && serverImage) {
        const pixels = Math.max(node.width, node.height) * previewScale * Math.max(1, dpr);
        return pixels <= 256 ? 256 : pixels <= 1024 ? 1024 : 0;
    }
    if (!width || !height || longest <= 256) return 0;
    const ratio = node.metadata?.freeResize ? Math.max(node.width / width, node.height / height) : Math.min(node.width / width, node.height / height);
    const pixels = longest * ratio * previewScale * Math.max(1, dpr);
    if (!Number.isFinite(pixels) || pixels >= longest * 0.75) return 0;
    return imageThumbnailEdges.find((edge) => edge >= pixels && edge < longest) || 0;
}

export function imageThumbnailSize(width: number, height: number, edge: number) {
    const ratio = Math.min(1, edge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
