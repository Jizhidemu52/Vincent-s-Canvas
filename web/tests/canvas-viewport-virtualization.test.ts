import { expect, test } from "bun:test";

import { canvasVirtualizationZoomRefreshRatio, shouldRefreshCanvasVirtualization } from "@/lib/canvas/canvas-viewport-virtualization";

test("refreshes virtualized canvas content before a long pan reaches the overscan edge", () => {
    expect(shouldRefreshCanvasVirtualization({ x: 0, y: 0, k: 1 }, { x: 399, y: 0, k: 1 }, 400)).toBe(false);
    expect(shouldRefreshCanvasVirtualization({ x: 0, y: 0, k: 1 }, { x: 400, y: 0, k: 1 }, 400)).toBe(true);
});

test("refreshes virtualized canvas content after a meaningful zoom change", () => {
    expect(shouldRefreshCanvasVirtualization({ x: 0, y: 0, k: 1 }, { x: 0, y: 0, k: 1.11 }, 400)).toBe(false);
    expect(shouldRefreshCanvasVirtualization({ x: 0, y: 0, k: 1 }, { x: 0, y: 0, k: 1.16 }, 400)).toBe(true);
});

test("uses a wider refresh interval inside overview mode but refreshes immediately across its boundary", () => {
    expect(canvasVirtualizationZoomRefreshRatio({ x: 0, y: 0, k: 1 }, { x: 0, y: 0, k: 0.85 })).toBe(0.16);
    expect(canvasVirtualizationZoomRefreshRatio({ x: 0, y: 0, k: 0.3 }, { x: 0, y: 0, k: 0.24 })).toBe(0.3);
    expect(shouldRefreshCanvasVirtualization({ x: 0, y: 0, k: 0.44 }, { x: 0, y: 0, k: 0.39 }, 400)).toBe(true);
});
