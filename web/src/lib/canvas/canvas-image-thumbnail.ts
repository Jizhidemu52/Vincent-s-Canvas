import type { CanvasNodeData } from "@/types/canvas";

export const imageThumbnailEdges = [256, 512, 1024] as const;
export type ImageThumbnailEdge = (typeof imageThumbnailEdges)[number];

/** 0 means original. Never enlarge a small source or soften a near-native view. */
export function canvasImagePreviewEdge(node: CanvasNodeData, scale: number, dpr = 1): ImageThumbnailEdge | 0 {
    if (node.type !== "image" || !node.metadata?.storageKey) return 0;
    const width = node.metadata.naturalWidth || 0;
    const height = node.metadata.naturalHeight || 0;
    const longest = Math.max(width, height);
    if (!width || !height || longest <= 256) return 0;
    const ratio = node.metadata.freeResize ? Math.max(node.width / width, node.height / height) : Math.min(node.width / width, node.height / height);
    const pixels = longest * ratio * Math.max(0.01, scale) * Math.max(1, dpr);
    if (!Number.isFinite(pixels) || pixels >= longest * 0.75) return 0;
    return imageThumbnailEdges.find((edge) => edge >= pixels && edge < longest) || 0;
}

export function imageThumbnailSize(width: number, height: number, edge: number) {
    const ratio = Math.min(1, edge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
