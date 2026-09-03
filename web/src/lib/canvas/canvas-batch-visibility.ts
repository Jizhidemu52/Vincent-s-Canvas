import type { CanvasNodeData } from "@/types/canvas";

export function createCanvasBatchRootIndex(nodes: CanvasNodeData[]) {
    return new Map(nodes.filter((node) => node.metadata?.isBatchRoot).map((node) => [node.id, node]));
}

export function isCanvasBatchChildHidden(node: CanvasNodeData, batchRootsById: ReadonlyMap<string, CanvasNodeData>, collapsingBatchIds?: ReadonlySet<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = batchRootsById.get(rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isCanvasBatchConnectionEndpointHidden(node: CanvasNodeData, batchRootsById: ReadonlyMap<string, CanvasNodeData>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = batchRootsById.get(rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}
