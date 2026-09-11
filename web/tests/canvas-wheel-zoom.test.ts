import { expect, test } from "bun:test";

import { canvasWheelTargetScale, canvasWheelZoomFactor, easeCanvasWheelViewport } from "@/lib/canvas/canvas-wheel-zoom";
import { zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";

test("matches the measured responsive zoom gain and reverses symmetrically", () => {
    expect(0.5 * canvasWheelZoomFactor(-100)).toBeCloseTo(0.6299605, 6);
    expect(canvasWheelZoomFactor(-100) * canvasWheelZoomFactor(100)).toBeCloseTo(1, 10);
});

test("caps a single anomalous wheel event so canvas zoom does not jump", () => {
    expect(canvasWheelZoomFactor(-2000)).toBeCloseTo(Math.pow(2, 0.8), 8);
    expect(canvasWheelZoomFactor(2000)).toBeCloseTo(Math.pow(2, -0.8), 8);
});

test("normalizes wheel units while retaining fine trackpad input", () => {
    expect(canvasWheelZoomFactor(-3, 1)).toBe(canvasWheelZoomFactor(-48));
    expect(canvasWheelZoomFactor(-0.1, 2, 600)).toBe(canvasWheelZoomFactor(-60));
    expect(canvasWheelZoomFactor(-0.5)).toBeGreaterThan(1);
    expect(canvasWheelZoomFactor(-0.5)).toBeLessThan(1.002);
    expect(canvasWheelZoomFactor(NaN)).toBe(1);
});

test("accumulates repeated input and reverses from the visible scale without drift", () => {
    expect(canvasWheelTargetScale(0.55, 0.63, 1.26)).toBeCloseTo(0.7938);
    expect(canvasWheelTargetScale(0.55, 0.63, 1 / 1.26)).toBeLessThan(0.55);
    expect(canvasWheelTargetScale(0.55, undefined, 1.26)).toBeCloseTo(0.693);
});

test("renders multiple intermediate frames with a fixed mouse anchor and exact endpoint", () => {
    const from = { x: 120, y: -30, k: 0.5 };
    const point = { x: 780, y: 420 };
    const to = zoomViewportAtPoint(from, point, from.k * canvasWheelZoomFactor(-100));
    let previous = from.k;
    for (const time of [0, 16, 33, 50, 66, 83, 100, 150]) {
        const frame = easeCanvasWheelViewport(from, to, time);
        expect(frame.k).toBeGreaterThanOrEqual(previous);
        expect(frame.k).toBeLessThanOrEqual(to.k);
        expect((point.x - frame.x) / frame.k).toBeCloseTo((point.x - from.x) / from.k, 8);
        expect((point.y - frame.y) / frame.k).toBeCloseTo((point.y - from.y) / from.k, 8);
        previous = frame.k;
    }
    expect(easeCanvasWheelViewport(from, to, 100)).toBe(to);
    expect(easeCanvasWheelViewport(from, to, 50).k).toBeGreaterThan(from.k);
    expect(easeCanvasWheelViewport(from, to, 50).k).toBeLessThan(to.k);
});
