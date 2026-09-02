import { expect, test } from "bun:test";

import { refreshVisibleConnectionsForDrag } from "@/lib/canvas/canvas-drag-visible-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x, y: 100 }, width: 100, height: 80 });
const bounds = { minX: 0, minY: 0, maxX: 800, maxY: 500 };

test("refreshes only dragged-node connections while retaining unrelated visible links", () => {
    const stable: CanvasConnection = { id: "stable", fromNodeId: "a", toNodeId: "b" };
    const exits: CanvasConnection = { id: "exits", fromNodeId: "dragged-out", toNodeId: "gone" };
    const enters: CanvasConnection = { id: "enters", fromNodeId: "dragged-in", toNodeId: "c" };
    const connectionById = new Map([
        [stable.id, stable],
        [exits.id, exits],
        [enters.id, enters],
    ]);
    const nodeById = new Map([
        ["a", node("a", 0)],
        ["b", node("b", 400)],
        ["c", node("c", 100)],
        ["dragged-out", node("dragged-out", -1400)],
        ["gone", node("gone", -900)],
        ["dragged-in", node("dragged-in", 100)],
    ]);

    expect(
        refreshVisibleConnectionsForDrag({
            baseVisibleConnections: [stable, exits],
            affectedConnectionIds: new Set([exits.id, enters.id]),
            connectionById,
            resolveNode: (nodeId) => nodeById.get(nodeId),
            bounds,
        }),
    ).toEqual([stable, enters]);
});
