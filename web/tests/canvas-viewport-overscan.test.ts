import { expect, test } from "bun:test";

import { canvasViewportOverscan } from "@/lib/canvas/canvas-viewport-overscan";

test("keeps a sub-viewport detail buffer that still exceeds the refresh distance", () => {
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 1 }, 1200, 720)).toBe(780);
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 2 }, 1200, 720)).toBe(390);
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 2 }, 200, 100)).toBe(280);
});

test("uses only a small screen-space safety margin in canvas overview mode", () => {
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 0.4 }, 1200, 720, "overview")).toBe(240);
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 0.2 }, 1200, 720, "overview")).toBe(480);
});
