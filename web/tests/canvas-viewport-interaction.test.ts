import { describe, expect, test } from "bun:test";

import { createCanvasViewportPreview, zoomViewportAtCanvasCenter, zoomViewportAtPoint } from "@/lib/canvas/canvas-viewport-interaction";

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

describe("canvas live viewport reconciliation", () => {
    test("retains the live camera through unrelated renders and late virtualized snapshots", () => {
        const initial = { x: 0, y: 0, k: 1 };
        const first = { x: 20, y: 30, k: 1.2 };
        const latest = { x: 40, y: 60, k: 1.4 };
        const camera = createCanvasViewportPreview(initial);
        camera.preview(first);
        camera.preview(latest);
        camera.commit(initial);
        expect(camera.current()).toBe(latest);
        camera.commit(first);
        expect(camera.current()).toBe(latest);
        camera.commit(latest);
        expect(camera.current()).toBe(latest);
    });

    test("allows explicit resets and restored viewports after a preview", () => {
        const initial = { x: 0, y: 0, k: 1 };
        const preview = { x: 20, y: 30, k: 1.2 };
        const reset = { x: 0, y: 0, k: 1 };
        const camera = createCanvasViewportPreview(initial);
        camera.preview(preview);
        camera.commit(reset);
        expect(camera.current()).toBe(reset);
        camera.commit(preview);
        expect(camera.current()).toBe(preview);
    });
});
