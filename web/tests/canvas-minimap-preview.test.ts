import { expect, test } from "bun:test";

import { minimapViewportAtWorldPoint } from "@/lib/canvas/canvas-minimap-preview";

test("centers a minimap preview on the requested world point without changing scale", () => {
    expect(minimapViewportAtWorldPoint({ x: 240, y: 180 }, { width: 1200, height: 800 }, 1.5)).toEqual({ x: 240, y: 130, k: 1.5 });
});
