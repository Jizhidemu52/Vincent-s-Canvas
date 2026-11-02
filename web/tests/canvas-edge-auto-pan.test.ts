import { expect, test } from "bun:test";
import { canvasEdgeAutoPanDelta } from "@/lib/canvas/canvas-edge-auto-pan";

const rect = { left: 200, top: 100, right: 1000, bottom: 700 };

test("the usable center and exact 48-pixel inner boundary do not pan", () => {
    expect(canvasEdgeAutoPanDelta({ x: 600, y: 400 }, rect, 16)).toEqual({ x: 0, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 248, y: 652 }, rect, 16)).toEqual({ x: 0, y: 0 });
});

test("left/top content moves right/down and right/bottom moves left/up at 600 pixels per second", () => {
    expect(canvasEdgeAutoPanDelta({ x: 200, y: 400 }, rect, 16)).toEqual({ x: 9.6, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 1000, y: 400 }, rect, 50)).toEqual({ x: -30, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 600, y: 100 }, rect, 50)).toEqual({ x: 0, y: 30 });
    expect(canvasEdgeAutoPanDelta({ x: 600, y: 700 }, rect, 50)).toEqual({ x: 0, y: -30 });
});

test("speed increases smoothly toward an edge and scales by frame duration", () => {
    const xs = [247, 236, 224, 212, 200].map(x => canvasEdgeAutoPanDelta({ x, y: 400 }, rect, 50).x);
    expect(xs.every((value, index) => !index || value > xs[index - 1]!)).toBe(true);
    expect(xs[2]).toBe(15);
    expect(canvasEdgeAutoPanDelta({ x: 224, y: 400 }, rect, 20).x).toBe(6);
});

test("long frames are capped at 50 ms and diagonal total speed never exceeds 600 pixels per second", () => {
    expect(canvasEdgeAutoPanDelta({ x: 200, y: 400 }, rect, 5000)).toEqual({ x: 30, y: 0 });
    const corner = canvasEdgeAutoPanDelta({ x: 200, y: 100 }, rect, 50);
    expect(corner.x).toBeCloseTo(corner.y); expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(30);
});

test("a pointer just outside may finish the drag, but outside the 48-pixel vicinity stops all panning", () => {
    expect(canvasEdgeAutoPanDelta({ x: 199, y: 400 }, rect, 50)).toEqual({ x: 30, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 151, y: 100 }, rect, 50)).toEqual({ x: 0, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 1000, y: 749 }, rect, 50)).toEqual({ x: 0, y: 0 });
});

test("invalid geometry, pointer or time does not move the viewport", () => {
    for (const value of [null, undefined, { ...rect, left: NaN }, { ...rect, right: rect.left }, { ...rect, bottom: 0 }]) expect(canvasEdgeAutoPanDelta({ x: 200, y: 400 }, value, 16)).toEqual({ x: 0, y: 0 });
    for (const point of [null, undefined, { x: Infinity, y: 400 }]) expect(canvasEdgeAutoPanDelta(point, rect, 16)).toEqual({ x: 0, y: 0 });
    for (const time of [0, -1, NaN, Infinity]) expect(canvasEdgeAutoPanDelta({ x: 200, y: 400 }, rect, time)).toEqual({ x: 0, y: 0 });
});

test("a very narrow usable rectangle has a stable center instead of competing edge forces", () => {
    const small = { left: 0, top: 0, right: 40, bottom: 30 };
    expect(canvasEdgeAutoPanDelta({ x: 20, y: 15 }, small, 16)).toEqual({ x: 0, y: 0 });
    expect(canvasEdgeAutoPanDelta({ x: 0, y: 15 }, small, 50)).toEqual({ x: 30, y: 0 });
});
