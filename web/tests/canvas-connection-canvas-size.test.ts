import { expect, test } from "bun:test";

import { canvasConnectionCanvasSize } from "@/lib/canvas/canvas-connection-canvas-size";

test("converts CSS connection-layer dimensions to device pixels once", () => {
    expect(canvasConnectionCanvasSize(640.2, 360.8, 1.5)).toEqual({ cssWidth: 640.2, cssHeight: 360.8, pixelRatio: 1.5, width: 960, height: 541 });
});

test("skips connection-layer drawing when the host has no drawable area", () => {
    expect(canvasConnectionCanvasSize(0, 360, 2)).toBeNull();
    expect(canvasConnectionCanvasSize(640, -1, 2)).toBeNull();
});
