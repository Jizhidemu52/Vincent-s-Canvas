import type { CanvasNodeData, CanvasNodeGroup } from "@/types/canvas";
import { createCanvasBatchRootIndex, isCanvasBatchChildHidden } from "./canvas-batch-visibility";
import { createCanvasGroupIndex } from "./canvas-node-groups";

/** Keep only selectable nodes; old documents without this optional field mean no selection. */
export function normalizeCanvasSelectedNodeIds(ids: Iterable<unknown> | undefined, nodes: CanvasNodeData[], groups: readonly CanvasNodeGroup[] = []): string[] {
    if (!ids || typeof ids === "string" || typeof ids[Symbol.iterator] !== "function") return [];
    const selected = [...ids].filter((id): id is string => typeof id === "string");
    if (!selected.length) return [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const { hiddenNodeIds } = createCanvasGroupIndex(groups, byId);
    const batches = createCanvasBatchRootIndex(nodes);
    return [...new Set(selected)].filter(id => {
        const node = byId.get(id);
        return node && !hiddenNodeIds.has(id) && !isCanvasBatchChildHidden(node, batches);
    });
}
