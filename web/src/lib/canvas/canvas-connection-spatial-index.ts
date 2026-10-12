import { boundsForCanvasConnection } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type NodeGeometry = { x: number; y: number; width: number; height: number };

export type CanvasConnectionSpatialIndex = {
    cellSize: number;
    boundsByConnectionId: Map<string, CanvasBounds>;
    connectionsById: Map<string, CanvasConnection>;
    connectionOrderById: Map<string, number>;
    cells: Map<string, Set<string>>;
    globalConnectionIds: Set<string>;
    sourceConnections: readonly CanvasConnection[];
    sourceConnectionCount: number;
    connectionOrdersByNodeId: Map<string, Set<number>>;
    nodeGeometryById: Map<string, NodeGeometry>;
};

const MAX_CELLS_PER_CONNECTION = 64;

export function createCanvasConnectionSpatialIndex(connections: CanvasConnection[], nodeById: ReadonlyMap<string, CanvasNodeData>, cellSize = 2048): CanvasConnectionSpatialIndex {
    const safeCellSize = Math.max(1, cellSize);
    const boundsByConnectionId = new Map<string, CanvasBounds>();
    const connectionsById = new Map<string, CanvasConnection>();
    const connectionOrderById = new Map<string, number>();
    const cells = new Map<string, Set<string>>();
    const globalConnectionIds = new Set<string>();
    const connectionOrdersByNodeId = new Map<string, Set<number>>();
    const nodeGeometryById = new Map<string, NodeGeometry>();

    connections.forEach((connection, order) => {
        for (const nodeId of [connection.fromNodeId, connection.toNodeId]) {
            const orders = connectionOrdersByNodeId.get(nodeId) ?? new Set<number>();
            orders.add(order);
            connectionOrdersByNodeId.set(nodeId, orders);
            const node = nodeById.get(nodeId);
            if (node && !nodeGeometryById.has(nodeId)) nodeGeometryById.set(nodeId, nodeGeometry(node));
        }
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

    return { cellSize: safeCellSize, boundsByConnectionId, connectionsById, connectionOrderById, cells, globalConnectionIds, sourceConnections: connections, sourceConnectionCount: connections.length, connectionOrdersByNodeId, nodeGeometryById };
}

/**
 * Connection arrays follow the document's immutable update contract. A stable
 * topology only needs an endpoint geometry scan, then updates the incident edges
 * of moved/resized/removed nodes. Grid cells are copied only when membership
 * changes; previous indexes remain usable by an in-progress render.
 */
export function refreshCanvasConnectionSpatialIndex(previous: CanvasConnectionSpatialIndex, connections: CanvasConnection[], nodeById: ReadonlyMap<string, CanvasNodeData>): CanvasConnectionSpatialIndex {
    if (!hasSameConnectionTopology(previous, connections)) {
        return createCanvasConnectionSpatialIndex(connections, nodeById, previous.cellSize);
    }

    let nodeGeometryById = previous.nodeGeometryById;
    const affectedOrders = new Set<number>();
    for (const [nodeId, orders] of previous.connectionOrdersByNodeId) {
        const node = nodeById.get(nodeId);
        if (hasSameNodeGeometry(previous.nodeGeometryById.get(nodeId), node)) continue;
        if (nodeGeometryById === previous.nodeGeometryById) nodeGeometryById = new Map(nodeGeometryById);
        if (node) nodeGeometryById.set(nodeId, nodeGeometry(node));
        else nodeGeometryById.delete(nodeId);
        orders.forEach((order) => affectedOrders.add(order));
    }
    if (!affectedOrders.size && previous.sourceConnections === connections) return previous;

    let boundsByConnectionId = previous.boundsByConnectionId;
    let connectionOrderById = previous.connectionOrderById;
    let connectionsById = previous.sourceConnections === connections ? previous.connectionsById
        : new Map(connections.filter((connection) => previous.boundsByConnectionId.has(connection.id)).map((connection) => [connection.id, connection]));
    let cells = previous.cells;
    let globalConnectionIds = previous.globalConnectionIds;
    const copiedCells = new Set<string>();
    const changeCell = (key: string, id: string, add: boolean) => {
        if (cells === previous.cells) cells = new Map(cells);
        let ids = cells.get(key);
        if (!copiedCells.has(key)) {
            ids = new Set(ids);
            copiedCells.add(key);
            cells.set(key, ids);
        } else if (!ids) {
            ids = new Set();
            cells.set(key, ids);
        }
        if (add) ids.add(id);
        else ids.delete(id);
        if (!ids.size) cells.delete(key);
    };

    for (const order of affectedOrders) {
        const connection = connections[order]!;
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        const bounds = from && to ? boundsForCanvasConnection(from, to) : undefined;
        const oldBounds = previous.boundsByConnectionId.get(connection.id);
        if (hasSameBounds(oldBounds, bounds)) continue;

        if (boundsByConnectionId === previous.boundsByConnectionId) boundsByConnectionId = new Map(boundsByConnectionId);
        if (bounds) boundsByConnectionId.set(connection.id, bounds);
        else boundsByConnectionId.delete(connection.id);
        if (Boolean(oldBounds) !== Boolean(bounds)) {
            if (connectionOrderById === previous.connectionOrderById) connectionOrderById = new Map(connectionOrderById);
            if (connectionsById === previous.connectionsById) connectionsById = new Map(connectionsById);
            if (bounds) {
                connectionsById.set(connection.id, connection);
                connectionOrderById.set(connection.id, order);
            } else {
                connectionsById.delete(connection.id);
                connectionOrderById.delete(connection.id);
            }
        }

        const wasGlobal = previous.globalConnectionIds.has(connection.id);
        const isGlobal = Boolean(bounds && cellCount(bounds, previous.cellSize) > MAX_CELLS_PER_CONNECTION);
        if (wasGlobal !== isGlobal) {
            if (globalConnectionIds === previous.globalConnectionIds) globalConnectionIds = new Set(globalConnectionIds);
            if (isGlobal) globalConnectionIds.add(connection.id);
            else globalConnectionIds.delete(connection.id);
        }
        const oldCells = connectionCells(oldBounds, wasGlobal, previous.cellSize);
        const nextCells = connectionCells(bounds, isGlobal, previous.cellSize);
        oldCells.forEach((key) => { if (!nextCells.has(key)) changeCell(key, connection.id, false); });
        nextCells.forEach((key) => { if (!oldCells.has(key)) changeCell(key, connection.id, true); });
    }

    return { ...previous, boundsByConnectionId, connectionsById, connectionOrderById, cells, globalConnectionIds, sourceConnections: connections, nodeGeometryById };
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

function hasSameConnectionTopology(index: CanvasConnectionSpatialIndex, connections: CanvasConnection[]) {
    if (index.sourceConnectionCount !== connections.length) return false;
    return index.sourceConnections === connections || connections.every((connection, order) => {
        const previous = index.sourceConnections[order];
        return previous?.id === connection.id && previous.fromNodeId === connection.fromNodeId && previous.toNodeId === connection.toNodeId;
    });
}

function nodeGeometry(node: CanvasNodeData): NodeGeometry {
    return { x: node.position.x, y: node.position.y, width: node.width, height: node.height };
}

function hasSameNodeGeometry(previous: NodeGeometry | undefined, node: CanvasNodeData | undefined) {
    if (!previous || !node) return !previous && !node;
    return previous.x === node.position.x && previous.y === node.position.y && previous.width === node.width && previous.height === node.height;
}

function hasSameBounds(previous: CanvasBounds | undefined, next: CanvasBounds | undefined) {
    if (!previous || !next) return previous === next;
    return previous.minX === next.minX && previous.minY === next.minY && previous.maxX === next.maxX && previous.maxY === next.maxY;
}

function connectionCells(bounds: CanvasBounds | undefined, global: boolean, cellSize: number) {
    const keys = new Set<string>();
    if (bounds && !global) forEachCell(bounds, cellSize, (key) => keys.add(key));
    return keys;
}
