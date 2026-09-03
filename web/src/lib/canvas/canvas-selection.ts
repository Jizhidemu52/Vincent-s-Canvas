import { selectCanvasSpatialIndexNodes, type CanvasBounds, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData } from "@/types/canvas";

export function selectCanvasNodeIdsInBounds(
    index: CanvasSpatialIndex,
    bounds: CanvasBounds,
    initialSelectedIds: ReadonlySet<string>,
    shouldInclude: (node: CanvasNodeData) => boolean = () => true,
) {
    const selected = new Set(initialSelectedIds);
    selectCanvasSpatialIndexNodes(index, bounds, shouldInclude).forEach((node) => selected.add(node.id));
    return selected;
}
