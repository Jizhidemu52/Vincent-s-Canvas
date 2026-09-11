import { expect, test } from "bun:test";

import { canvasWheelZoomFactor } from "@/lib/canvas/canvas-wheel-zoom";
import { zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";

test("increases wheel gain without quantizing small inputs", () => {
    expect(0.5 * canvasWheelZoomFactor(-100)).toBeCloseTo(0.6674199, 6);
    expect(canvasWheelZoomFactor(-12)).toBeCloseTo(Math.pow(2, 0.05), 10);
    expect(canvasWheelZoomFactor(-100) * canvasWheelZoomFactor(100)).toBeCloseTo(1, 10);
});

test("retains the existing maximum single-event jump for anomalous input", () => {
    expect(canvasWheelZoomFactor(-2000)).toBeCloseTo(Math.pow(2, 0.8), 8);
    expect(canvasWheelZoomFactor(2000)).toBeCloseTo(Math.pow(2, -0.8), 8);
});

test("normalizes wheel units while retaining fine trackpad input", () => {
    expect(canvasWheelZoomFactor(-3, 1)).toBe(canvasWheelZoomFactor(-48));
    expect(canvasWheelZoomFactor(-0.1, 2, 600)).toBe(canvasWheelZoomFactor(-60));
    expect(canvasWheelZoomFactor(-0.5)).toBeGreaterThan(1);
    expect(canvasWheelZoomFactor(-0.5)).toBeLessThan(1.002);
    expect(canvasWheelZoomFactor(0)).toBe(1);
    expect(canvasWheelZoomFactor(NaN)).toBe(1);
    expect(canvasWheelZoomFactor(Infinity)).toBe(1);
});

test("coalesced and separate normal wheel events produce the same scale", () => {
    const separate = Array.from({ length: 8 }, () => -12).reduce((k, delta) => k * canvasWheelZoomFactor(delta), 0.5);
    expect(separate).toBeCloseTo(0.5 * canvasWheelZoomFactor(-96), 10);
    const reversed = [24, 12, 36, 24].reduce((k, delta) => k * canvasWheelZoomFactor(delta), separate);
    expect(reversed).toBeCloseTo(0.5, 10);
});

test("composing pending input preserves the anchor and reverses exactly", () => {
    const from = { x: 120, y: -30, k: 0.5 };
    const point = { x: 780, y: 420 };
    let pending = from;
    for (const delta of [-12, -12, -48, -24, 36, 60]) {
        pending = zoomViewportAtPoint(pending, point, pending.k * canvasWheelZoomFactor(delta));
        expect((point.x - pending.x) / pending.k).toBeCloseTo((point.x - from.x) / from.k, 8);
        expect((point.y - pending.y) / pending.k).toBeCloseTo((point.y - from.y) / from.k, 8);
    }
    expect(pending.k).toBeCloseTo(from.k, 10);
    expect(pending.x).toBeCloseTo(from.x, 8);
    expect(pending.y).toBeCloseTo(from.y, 8);
});
