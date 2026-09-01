import { describe, expect, test } from "bun:test";

import { zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";

describe("canvas viewport interaction", () => {
    test("keeps the world point below the cursor fixed while zooming", () => {
        const viewport = { x: 180, y: 120, k: 1 };
        const cursor = { x: 420, y: 300 };
        const worldBefore = { x: (cursor.x - viewport.x) / viewport.k, y: (cursor.y - viewport.y) / viewport.k };

        const next = zoomViewportAtPoint(viewport, cursor, 1.6);
        const worldAfter = { x: (cursor.x - next.x) / next.k, y: (cursor.y - next.y) / next.k };

        expect(worldAfter.x).toBeCloseTo(worldBefore.x);
        expect(worldAfter.y).toBeCloseTo(worldBefore.y);
        expect(next.k).toBe(1.6);
    });
});
