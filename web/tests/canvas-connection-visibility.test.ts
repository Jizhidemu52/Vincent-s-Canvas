import { describe, expect, test } from "bun:test";

import { connectionIntersectsCanvasBounds } from "@/lib/canvas/canvas-connection-visibility";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y },
    width: 120,
    height: 80,
});

describe("canvas connection visibility", () => {
    test("keeps a connection that crosses the visible world bounds", () => {
        expect(connectionIntersectsCanvasBounds(node("source", -1000, 120), node("target", 1200, 120), { minX: 0, minY: 0, maxX: 800, maxY: 500 })).toBe(true);
    });

    test("removes a connection whose curve stays outside the visible world bounds", () => {
        expect(connectionIntersectsCanvasBounds(node("source", -1400, -1000), node("target", -900, -800), { minX: 0, minY: 0, maxX: 800, maxY: 500 })).toBe(false);
    });
});
