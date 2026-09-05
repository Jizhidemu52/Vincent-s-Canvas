import { expect, test } from "bun:test";

import { canvasOverviewViewportBounds, nodeIntersectsCanvasOverviewViewport } from "@/lib/canvas/canvas-overview-visibility";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (x: number, y: number, width = 100, height = 80): CanvasNodeData => ({
    id: `${x}:${y}`,
    type: CanvasNodeType.Text,
    title: "node",
    position: { x, y },
    width,
    height,
});

test("keeps overview nodes that intersect the current world viewport", () => {
    const viewport = { x: 50, y: 40, k: 1 };
    const canvasSize = { width: 400, height: 300 };

    expect(nodeIntersectsCanvasOverviewViewport(node(-20, 20), viewport, canvasSize)).toBe(true);
    expect(nodeIntersectsCanvasOverviewViewport(node(600, 20), viewport, canvasSize)).toBe(false);
    expect(nodeIntersectsCanvasOverviewViewport(node(20, 500), viewport, canvasSize)).toBe(false);
});

test("uses the live zoomed viewport instead of the cached overscan area", () => {
    const viewport = { x: 0, y: 0, k: 0.5 };
    const canvasSize = { width: 400, height: 300 };

    expect(nodeIntersectsCanvasOverviewViewport(node(700, 100), viewport, canvasSize)).toBe(true);
    expect(nodeIntersectsCanvasOverviewViewport(node(900, 100), viewport, canvasSize)).toBe(false);
});

test("creates a tight overview viewport bound with only a screen-space margin", () => {
    expect(canvasOverviewViewportBounds({ x: 0, y: 0, k: 0.5 }, { width: 400, height: 300 })).toEqual({
        minX: -48,
        minY: -48,
        maxX: 848,
        maxY: 648,
    });
});
