import { isCanvasBatchChildHidden } from "@/lib/canvas/canvas-batch-visibility";
import { selectCanvasSpatialIndexNodes, type CanvasBounds, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData } from "@/types/canvas";

function sameBounds(first: CanvasBounds | null, second: CanvasBounds) {
    return Boolean(first && first.minX === second.minX && first.minY === second.minY && first.maxX === second.maxX && first.maxY === second.maxY);
}

/**
 * A streamed content update keeps the spatial grid and viewport stable. Keep
 * the selected node IDs for that common case, then refresh only the mounted
 * node records from the live index instead of querying and sorting the grid
 * again for every chunk.
 */
export function createCanvasVisibleNodeCache() {
    let previousIndex: CanvasSpatialIndex | null = null;
    let previousBounds: CanvasBounds | null = null;
    let previousBatchRoots: ReadonlyMap<string, CanvasNodeData> | null = null;
    let previousCollapsing: ReadonlySet<string> | undefined;
    let previousIds: string[] = [];
    let previous: CanvasNodeData[] = [];

    return {
        select(index: CanvasSpatialIndex, bounds: CanvasBounds, batchRootsById: ReadonlyMap<string, CanvasNodeData>, collapsingBatchIds?: ReadonlySet<string>) {
            const canReuseIds = previousIndex === index && sameBounds(previousBounds, bounds) && previousBatchRoots === batchRootsById && previousCollapsing === collapsingBatchIds;
            if (!canReuseIds) {
                const next = selectCanvasSpatialIndexNodes(index, bounds, (node) => !isCanvasBatchChildHidden(node, batchRootsById, collapsingBatchIds));
                previousIndex = index;
                previousBounds = bounds;
                previousBatchRoots = batchRootsById;
                previousCollapsing = collapsingBatchIds;
                previousIds = next.map((node) => node.id);
                previous = next;
                return previous;
            }

            const next = previousIds.map((id) => index.nodesById.get(id)).filter((node): node is CanvasNodeData => Boolean(node));
            if (next.length === previous.length && next.every((node, position) => node === previous[position])) return previous;
            previous = next;
            return previous;
        },
    };
}
