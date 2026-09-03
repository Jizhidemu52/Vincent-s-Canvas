import { describe, expect, test } from "bun:test";

import { connectionIntersectsCanvasBounds } from "@/lib/canvas/canvas-connection-visibility";
import { createCanvasConnectionSpatialIndex, selectCanvasSpatialIndexConnections } from "@/lib/canvas/canvas-connection-spatial-index";
import { createCanvasSpatialIndex, selectIndexedCanvasNodes } from "@/lib/canvas/canvas-spatial-index";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const nodes = Array.from({ length: 500 }, (_, index): CanvasNodeData => ({
    id: `node-${index}`,
    type: CanvasNodeType.Text,
    title: `Node ${index}`,
    position: { x: (index % 25) * 460, y: Math.floor(index / 25) * 320 },
    width: 300,
    height: 180,
}));

const connections = Array.from({ length: 1000 }, (_, index): CanvasConnection => ({
    id: `connection-${index}`,
    fromNodeId: nodes[index % nodes.length].id,
    toNodeId: nodes[(index + (index % 2 === 0 ? 1 : 25)) % nodes.length].id,
}));

describe("canvas performance fixture", () => {
    test("culls a 500-node and 1000-connection project to the current viewport", () => {
        const bounds = { minX: -280, minY: -280, maxX: 1480, maxY: 1000 };
        const index = createCanvasSpatialIndex(nodes);
        const visibleNodes = selectIndexedCanvasNodes(nodes, index, bounds, () => true);
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const expectedVisibleConnections = connections.filter((connection) => connectionIntersectsCanvasBounds(nodeById.get(connection.fromNodeId)!, nodeById.get(connection.toNodeId)!, bounds));
        const connectionIndex = createCanvasConnectionSpatialIndex(connections, nodeById);
        const visibleConnections = selectCanvasSpatialIndexConnections(connectionIndex, bounds);

        expect(visibleNodes.length).toBeLessThan(nodes.length / 4);
        expect(visibleConnections.length).toBeLessThan(connections.length / 4);
        expect(visibleConnections.map((connection) => connection.id)).toEqual(expectedVisibleConnections.map((connection) => connection.id));
    });
});
