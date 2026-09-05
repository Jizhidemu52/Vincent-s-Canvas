import { describe, expect, test } from "bun:test";

import { zoomViewportAtCanvasCenter, zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";

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

    test("keeps the canvas center fixed while previewing slider zoom", () => {
        const viewport = { x: 180, y: 120, k: 1 };
        const canvasSize = { width: 960, height: 640 };
        const center = { x: canvasSize.width / 2, y: canvasSize.height / 2 };
        const worldBefore = { x: (center.x - viewport.x) / viewport.k, y: (center.y - viewport.y) / viewport.k };

        const next = zoomViewportAtCanvasCenter(viewport, canvasSize, 1.6);
        const worldAfter = { x: (center.x - next.x) / next.k, y: (center.y - next.y) / next.k };

        expect(worldAfter.x).toBeCloseTo(worldBefore.x);
        expect(worldAfter.y).toBeCloseTo(worldBefore.y);
        expect(next.k).toBe(1.6);
    });
});
