import type { QuickImageAction } from "@/lib/quick-image-tools";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type ImageSourceMetadata = Pick<CanvasNodeMetadata, "content" | "storageKey" | "serverAssetId">;

export function serverAssetContentUrl(serverAssetId?: string) {
    const value = typeof serverAssetId === "string" ? serverAssetId.trim() : "";
    return value ? `/api/assets/${encodeURIComponent(value)}/content` : "";
}

export function canvasImageSource(metadata?: ImageSourceMetadata) {
    return serverAssetContentUrl(metadata?.serverAssetId) || metadata?.content || "";
}

export function hasCanvasImageSource<T extends ImageSourceMetadata>(metadata?: T): metadata is T & ({ content: string } | { storageKey: string } | { serverAssetId: string }) {
    return Boolean(metadata?.content || metadata?.storageKey || metadata?.serverAssetId);
}

export function hasPendingCanvasImageAction(nodes: readonly CanvasNodeData[], sourceId: string, action: QuickImageAction) {
    return nodes.some(({ metadata }) => metadata?.quickImageAction === action && metadata.generationRecord?.sourceNodeId === sourceId && (metadata.imageTask || metadata.status === "loading"));
}
