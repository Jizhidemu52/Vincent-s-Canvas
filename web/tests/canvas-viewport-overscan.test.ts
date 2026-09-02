import { expect, test } from "bun:test";

import { canvasViewportOverscan } from "@/lib/canvas/canvas-viewport-overscan";

test("preloads one viewport in world coordinates while respecting a small-canvas minimum", () => {
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 1 }, 1200, 720)).toBe(1200);
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 2 }, 1200, 720)).toBe(600);
    expect(canvasViewportOverscan({ x: 0, y: 0, k: 2 }, 200, 100)).toBe(280);
});
