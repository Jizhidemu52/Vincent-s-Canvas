import { describe, expect, test } from "bun:test";

import { boundsForViewport, createCanvasSpatialIndex, queryCanvasSpatialIndex, selectIndexedCanvasNodes } from "@/lib/canvas/canvas-spatial-index";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y },
    width,
    height,
});

describe("canvas spatial index", () => {
    test("returns each node once when it spans multiple grid cells", () => {
        const index = createCanvasSpatialIndex([node("wide", 900, 0, 300, 100), node("negative", -80, -80)], 1024);

        expect(queryCanvasSpatialIndex(index, { minX: 800, minY: -100, maxX: 1300, maxY: 200 })).toEqual(["wide"]);
    });

    test("finds a node stored in negative coordinate cells", () => {
        const index = createCanvasSpatialIndex([node("negative", -180, -140, 80, 80)], 1024);

        expect(queryCanvasSpatialIndex(index, { minX: -200, minY: -200, maxX: -90, maxY: -40 })).toEqual(["negative"]);
    });

    test("converts a translated viewport and padding into world bounds", () => {
        expect(boundsForViewport({ x: 200, y: 100, k: 2 }, 400, 200, 50)).toEqual({ minX: -150, minY: -100, maxX: 150, maxY: 100 });
    });

    test("keeps stacking order while applying a node visibility predicate", () => {
        const nodes = [node("far", 4000, 0), node("visible", 80, 40), node("hidden", 160, 40)];
        const index = createCanvasSpatialIndex(nodes, 1024);

        expect(selectIndexedCanvasNodes(nodes, index, { minX: 0, minY: 0, maxX: 400, maxY: 400 }, (candidate) => candidate.id !== "hidden").map((candidate) => candidate.id)).toEqual(["visible"]);
    });
});
