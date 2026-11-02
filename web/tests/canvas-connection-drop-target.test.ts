import { expect, test } from "bun:test";

import { findCanvasConnectionDropTarget } from "@/lib/canvas/canvas-connection-drop-target";
import { createCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x, y },
    width: 100,
    height: 100,
});

test("chooses the topmost compatible node at the same drop location", () => {
    const bottom = node("bottom", 100, 100);
    const top = node("top", 100, 100);

    const result = findCanvasConnectionDropTarget({
        index: createCanvasSpatialIndex([bottom, top]),
        world: { x: 140, y: 140 },
        current: { nodeId: "source", handleType: "source" },
        scale: 1,
        canConnect: () => true,
    });

    expect(result).toEqual({ nodeId: "top", isNearNode: true });
});

test("prioritizes the actual port over the body of a nearby node", () => {
    const inside = node("inside", 100, 100);
    const handleOnly = node("handle", 200, 90);

    const result = findCanvasConnectionDropTarget({
        index: createCanvasSpatialIndex([inside, handleOnly]),
        world: { x: 165, y: 140 },
        current: { nodeId: "source", handleType: "source" },
        scale: 1,
        canConnect: () => true,
    });

    expect(result).toEqual({ nodeId: "handle", isNearNode: true });
});

test("keeps a near but incompatible node from becoming a drop target", () => {
    const result = findCanvasConnectionDropTarget({
        index: createCanvasSpatialIndex([node("target", 100, 100)]),
        world: { x: 140, y: 140 },
        current: { nodeId: "source", handleType: "source" },
        scale: 1,
        canConnect: () => false,
    });

    expect(result).toEqual({ nodeId: null, isNearNode: true, invalidNodeId: "target" });
});

test("chooses the closest port independently of array order", () => {
    for (const nodes of [[node("near", 100, 100), node("far", 130, 100)], [node("far", 130, 100), node("near", 100, 100)]]) {
        expect(findCanvasConnectionDropTarget({ index: createCanvasSpatialIndex(nodes), world: { x: 105, y: 150 }, current: { nodeId: "source", handleType: "source" }, scale: 1, canConnect: () => true }).nodeId).toBe("near");
    }
});

test("a hidden node and the originating port cannot become targets", () => {
    const result = findCanvasConnectionDropTarget({ index: createCanvasSpatialIndex([node("source", 100, 100), node("hidden", 100, 100)]), world: { x: 100, y: 150 }, current: { nodeId: "source", handleType: "source" }, scale: 1, canConnect: () => true, isHiddenNode: node => node.id === "hidden" });
    expect(result).toEqual({ nodeId: null, isNearNode: true });
});
