import { expect, test } from "bun:test";

import { canvasWheelZoomFactor } from "@/lib/canvas/canvas-wheel-zoom";

test("keeps ordinary wheel zoom increments unchanged", () => {
    expect(canvasWheelZoomFactor(-100)).toBeCloseTo(1.1, 8);
    expect(canvasWheelZoomFactor(100)).toBeCloseTo(1 / 1.1, 8);
});

test("caps a single anomalous wheel event so canvas zoom does not jump", () => {
    expect(canvasWheelZoomFactor(-2000)).toBeCloseTo(Math.pow(1.1, 1.6), 8);
    expect(canvasWheelZoomFactor(2000)).toBeCloseTo(Math.pow(1.1, -1.6), 8);
});
