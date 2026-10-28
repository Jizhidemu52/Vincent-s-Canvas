import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function isCanvasPdfImage(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && Boolean(node.metadata?.storageKey || node.metadata?.content);
}

/** Batch roots are covers, not additional files; expand in explicit child order. */
export function canvasImageExportSelection(nodes: readonly CanvasNodeData[], selectedIds?: readonly string[]) {
    if (selectedIds?.length === 0) return [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result = new Map<string, CanvasNodeData>();
    const visited = new Set<string>();
    const add = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const node = byId.get(id);
        if (!node) return;
        const children = node.metadata?.isBatchRoot ? (node.metadata.batchChildIds || []).filter((childId) => childId !== id && byId.has(childId) && isCanvasPdfImage(byId.get(childId)!)) : [];
        if (children.length) children.forEach(add);
        else if (isCanvasPdfImage(node)) result.set(id, node);
    };
    (selectedIds || nodes.map((node) => node.id)).forEach(add);
    return [...result.values()];
}
