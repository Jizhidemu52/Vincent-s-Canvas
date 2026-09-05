import { expect, test } from "bun:test";

import { canvasConnectionCanvasSize } from "@/lib/canvas/canvas-connection-canvas-size";

test("converts CSS connection-layer dimensions to device pixels once", () => {
    expect(canvasConnectionCanvasSize(640.2, 360.8, 1.5)).toEqual({ cssWidth: 640.2, cssHeight: 360.8, pixelRatio: 1.5, width: 960, height: 541 });
});

test("caps expensive high-density canvas buffers while preserving standard 2x rendering", () => {
    expect(canvasConnectionCanvasSize(640, 360, 3)).toEqual({ cssWidth: 640, cssHeight: 360, pixelRatio: 2, width: 1280, height: 720 });
});

test("allows transient preview layers to opt into a 1x backing buffer", () => {
    expect(canvasConnectionCanvasSize(640, 360, 3, 1)).toEqual({ cssWidth: 640, cssHeight: 360, pixelRatio: 1, width: 640, height: 360 });
});

test("falls back to a usable pixel ratio when the browser value is invalid", () => {
    expect(canvasConnectionCanvasSize(640, 360, Number.NaN)).toEqual({ cssWidth: 640, cssHeight: 360, pixelRatio: 1, width: 640, height: 360 });
});

test("skips connection-layer drawing when the host has no drawable area", () => {
    expect(canvasConnectionCanvasSize(0, 360, 2)).toBeNull();
    expect(canvasConnectionCanvasSize(640, -1, 2)).toBeNull();
});
