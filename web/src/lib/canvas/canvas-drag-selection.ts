import type { CanvasNodeData } from "@/types/canvas";

export type CanvasDragNodePosition = { id: string; x: number; y: number };

/**
 * A drag only needs the selected nodes and their batch dependents. Reading
 * them directly from the live node map avoids two full-canvas scans per drag.
 */
export function collectCanvasDragNodes(selectedIds: ReadonlySet<string>, nodesById: ReadonlyMap<string, CanvasNodeData>) {
    const ids = new Set(selectedIds);
    selectedIds.forEach((id) => nodesById.get(id)?.metadata?.batchChildIds?.forEach((childId) => ids.add(childId)));

    const nodes: CanvasDragNodePosition[] = [];
    ids.forEach((id) => {
        const node = nodesById.get(id);
        if (node) nodes.push({ id: node.id, x: node.position.x, y: node.position.y });
    });
    return { ids, nodes };
}
