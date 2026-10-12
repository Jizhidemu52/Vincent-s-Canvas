import { CanvasNodeType, type CanvasCompareSource, type CanvasNodeData } from "@/types/canvas";

/** Legacy reference arrays may have dropped inputs; never infer a unique original from them. */
export function inlineCompareSources(node: CanvasNodeData): { sources: CanvasCompareSource[]; automatic: boolean } {
    if (node.type !== CanvasNodeType.Image) return { sources: [], automatic: false };
    const snapshots = node.metadata?.compareSources;
    if (snapshots !== undefined) {
        const sources = snapshots.filter(source => source.type === "image" && Boolean(source.storageKey || source.content));
        return { sources, automatic: snapshots.length === 1 && sources.length === 1 };
    }
    const sources = (node.metadata?.references || []).filter(Boolean).map((content): CanvasCompareSource => content.startsWith("image:") ? { type: "image", storageKey: content, content: "" } : { type: "image", content });
    return { sources, automatic: false };
}

export function clampInlineComparePercent(value: number) {
    return Number.isNaN(value) ? 50 : Math.min(100, Math.max(0, value));
}

export function inlineComparePercentFromClientX(clientX: number, bounds: { left: number; width: number }) {
    if (!Number.isFinite(clientX) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.width) || bounds.width <= 0) return 50;
    return clampInlineComparePercent((clientX - bounds.left) / bounds.width * 100);
}
