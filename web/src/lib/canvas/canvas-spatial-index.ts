import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasBounds = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

export type CanvasSpatialIndex = {
    cellSize: number;
    boundsByNodeId: Map<string, CanvasBounds>;
    nodesById: Map<string, CanvasNodeData>;
    nodeOrderById: Map<string, number>;
    cells: Map<string, Set<string>>;
};

const DEFAULT_CELL_SIZE = 1024;

export function boundsForCanvasNode(node: CanvasNodeData): CanvasBounds {
    return {
        minX: node.position.x,
        minY: node.position.y,
        maxX: node.position.x + node.width,
        maxY: node.position.y + node.height,
    };
}

export function boundsForViewport(viewport: ViewportTransform, width: number, height: number, padding: number): CanvasBounds {
    const scale = Math.max(viewport.k, 0.0001);
    const minX = -viewport.x / scale - padding;
    const minY = -viewport.y / scale - padding;

    return {
        minX,
        minY,
        maxX: minX + width / scale + padding * 2,
        maxY: minY + height / scale + padding * 2,
    };
}

export function createCanvasSpatialIndex(nodes: CanvasNodeData[], cellSize = DEFAULT_CELL_SIZE): CanvasSpatialIndex {
    const safeCellSize = Math.max(1, cellSize);
    const boundsByNodeId = new Map<string, CanvasBounds>();
    const nodesById = new Map<string, CanvasNodeData>();
    const nodeOrderById = new Map<string, number>();
    const cells = new Map<string, Set<string>>();

    nodes.forEach((node, order) => {
        const bounds = boundsForCanvasNode(node);
        boundsByNodeId.set(node.id, bounds);
        nodesById.set(node.id, node);
        nodeOrderById.set(node.id, order);
        forEachCell(bounds, safeCellSize, (key) => {
            const ids = cells.get(key) ?? new Set<string>();
            ids.add(node.id);
            cells.set(key, ids);
        });
    });

    return { cellSize: safeCellSize, boundsByNodeId, nodesById, nodeOrderById, cells };
}

export function queryCanvasSpatialIndex(index: CanvasSpatialIndex, bounds: CanvasBounds): string[] {
    const ids = new Set<string>();

    forEachCell(bounds, index.cellSize, (key) => {
        index.cells.get(key)?.forEach((id) => ids.add(id));
    });

    return [...ids].filter((id) => intersects(index.boundsByNodeId.get(id), bounds));
}

export function selectIndexedCanvasNodes(_nodes: CanvasNodeData[], index: CanvasSpatialIndex, bounds: CanvasBounds, shouldInclude: (node: CanvasNodeData) => boolean = () => true): CanvasNodeData[] {
    return selectCanvasSpatialIndexNodes(index, bounds, shouldInclude);
}

export function selectCanvasSpatialIndexNodes(index: CanvasSpatialIndex, bounds: CanvasBounds, shouldInclude: (node: CanvasNodeData) => boolean = () => true): CanvasNodeData[] {
    return queryCanvasSpatialIndex(index, bounds)
        .map((id) => index.nodesById.get(id))
        .filter((node): node is CanvasNodeData => Boolean(node && shouldInclude(node)))
        .sort((first, second) => (index.nodeOrderById.get(first.id) || 0) - (index.nodeOrderById.get(second.id) || 0));
}

function forEachCell(bounds: CanvasBounds, cellSize: number, callback: (key: string) => void) {
    const minCellX = Math.floor(bounds.minX / cellSize);
    const maxCellX = Math.floor((bounds.maxX - Number.EPSILON) / cellSize);
    const minCellY = Math.floor(bounds.minY / cellSize);
    const maxCellY = Math.floor((bounds.maxY - Number.EPSILON) / cellSize);

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            callback(`${cellX}:${cellY}`);
        }
    }
}

function intersects(first: CanvasBounds | undefined, second: CanvasBounds) {
    return Boolean(first && first.maxX > second.minX && first.minX < second.maxX && first.maxY > second.minY && first.minY < second.maxY);
}
