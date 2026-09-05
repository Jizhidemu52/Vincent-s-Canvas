import { expect, test } from "bun:test";

import { collectCanvasDragNodes } from "@/lib/canvas/canvas-drag-selection";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, x: number, batchChildIds?: string[]): CanvasNodeData {
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x, y: 0 },
        width: 100,
        height: 100,
        metadata: batchChildIds ? { batchChildIds } : undefined,
    };
}

test("collects only selected nodes and their batch children without scanning the canvas list", () => {
    const root = node("root", 0, ["child-a", "child-b"]);
    const childA = node("child-a", 120);
    const childB = node("child-b", 240);
    const unrelated = node("unrelated", 360);

    const result = collectCanvasDragNodes(new Set(["root"]), new Map([[root.id, root], [childA.id, childA], [childB.id, childB], [unrelated.id, unrelated]]));

    expect(result.ids).toEqual(new Set(["root", "child-a", "child-b"]));
    expect(result.nodes.map((item) => item.id)).toEqual(["root", "child-a", "child-b"]);
    expect(result.nodes.map((item) => item.x)).toEqual([0, 120, 240]);
});

test("ignores removed batch children safely", () => {
    const root = node("root", 0, ["missing"]);
    const result = collectCanvasDragNodes(new Set(["root"]), new Map([[root.id, root]]));

    expect(result.ids).toEqual(new Set(["root", "missing"]));
    expect(result.nodes).toEqual([{ id: "root", x: 0, y: 0 }]);
});
