import { boundsForCanvasConnection } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasConnectionSpatialIndex = {
    cellSize: number;
    boundsByConnectionId: Map<string, CanvasBounds>;
    connectionsById: Map<string, CanvasConnection>;
    connectionOrderById: Map<string, number>;
    cells: Map<string, Set<string>>;
    globalConnectionIds: Set<string>;
};

const MAX_CELLS_PER_CONNECTION = 64;

export function createCanvasConnectionSpatialIndex(connections: CanvasConnection[], nodeById: ReadonlyMap<string, CanvasNodeData>, cellSize = 2048): CanvasConnectionSpatialIndex {
    const safeCellSize = Math.max(1, cellSize);
    const boundsByConnectionId = new Map<string, CanvasBounds>();
    const connectionsById = new Map<string, CanvasConnection>();
    const connectionOrderById = new Map<string, number>();
    const cells = new Map<string, Set<string>>();
    const globalConnectionIds = new Set<string>();

    connections.forEach((connection, order) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) return;
        const bounds = boundsForCanvasConnection(from, to);
        boundsByConnectionId.set(connection.id, bounds);
        connectionsById.set(connection.id, connection);
        connectionOrderById.set(connection.id, order);
        if (cellCount(bounds, safeCellSize) > MAX_CELLS_PER_CONNECTION) {
            globalConnectionIds.add(connection.id);
            return;
        }
        forEachCell(bounds, safeCellSize, (key) => {
            const ids = cells.get(key) ?? new Set<string>();
            ids.add(connection.id);
            cells.set(key, ids);
        });
    });

    return { cellSize: safeCellSize, boundsByConnectionId, connectionsById, connectionOrderById, cells, globalConnectionIds };
}

export function selectCanvasSpatialIndexConnections(index: CanvasConnectionSpatialIndex, bounds: CanvasBounds, shouldInclude: (connection: CanvasConnection) => boolean = () => true): CanvasConnection[] {
    const ids = new Set(index.globalConnectionIds);
    forEachCell(bounds, index.cellSize, (key) => index.cells.get(key)?.forEach((id) => ids.add(id)));

    return Array.from(ids)
        .filter((id) => intersects(index.boundsByConnectionId.get(id), bounds))
        .map((id) => index.connectionsById.get(id))
        .filter((connection): connection is CanvasConnection => Boolean(connection && shouldInclude(connection)))
        .sort((first, second) => (index.connectionOrderById.get(first.id) || 0) - (index.connectionOrderById.get(second.id) || 0));
}

function cellCount(bounds: CanvasBounds, cellSize: number) {
    const minCellX = Math.floor(bounds.minX / cellSize);
    const maxCellX = Math.floor((bounds.maxX - Number.EPSILON) / cellSize);
    const minCellY = Math.floor(bounds.minY / cellSize);
    const maxCellY = Math.floor((bounds.maxY - Number.EPSILON) / cellSize);
    return (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1);
}

function forEachCell(bounds: CanvasBounds, cellSize: number, callback: (key: string) => void) {
    const minCellX = Math.floor(bounds.minX / cellSize);
    const maxCellX = Math.floor((bounds.maxX - Number.EPSILON) / cellSize);
    const minCellY = Math.floor(bounds.minY / cellSize);
    const maxCellY = Math.floor((bounds.maxY - Number.EPSILON) / cellSize);

    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) callback(`${cellX}:${cellY}`);
    }
}

function intersects(first: CanvasBounds | undefined, second: CanvasBounds) {
    return Boolean(first && first.maxX > second.minX && first.minX < second.maxX && first.maxY > second.minY && first.minY < second.maxY);
}
