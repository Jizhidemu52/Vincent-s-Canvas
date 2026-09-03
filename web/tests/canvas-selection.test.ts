import { expect, test } from "bun:test";

import { selectCanvasNodeIdsInBounds } from "@/lib/canvas/canvas-selection";
import { createCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y },
    width: 100,
    height: 100,
});

test("selects intersecting indexed nodes while retaining an additive selection", () => {
    const nodes = [node("inside", 40, 40), node("outside", 3000, 40), node("hidden", 80, 80)];
    const index = createCanvasSpatialIndex(nodes, 1024);

    const selected = selectCanvasNodeIdsInBounds(index, { minX: 0, minY: 0, maxX: 180, maxY: 180 }, new Set(["kept"]), (candidate) => candidate.id !== "hidden");

    expect([...selected]).toEqual(["kept", "inside"]);
});
