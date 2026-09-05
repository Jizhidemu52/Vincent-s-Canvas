import { expect, test } from "bun:test";

import { findCanvasOverviewNodeHit } from "@/lib/canvas/canvas-overview-hit-test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 120, height: 80 });

test("selects the topmost overview node at the pointer", () => {
    const lower = node("lower", 10, 10);
    const upper = node("upper", 60, 30);

    expect(findCanvasOverviewNodeHit([lower, upper], { x: 80, y: 50 })).toBe(upper);
    expect(findCanvasOverviewNodeHit([lower, upper], { x: 20, y: 20 })).toBe(lower);
});

test("does not select empty overview space", () => {
    expect(findCanvasOverviewNodeHit([node("node", 10, 10)], { x: 200, y: 200 })).toBeNull();
});
