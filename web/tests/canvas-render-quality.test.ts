import { describe, expect, test } from "bun:test";

import { canvasRenderQualityAtScale, isCanvasOverviewScale, nextCanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

describe("canvas render quality", () => {
    test("uses the moving quality while an interaction is active", () => {
        expect(nextCanvasRenderQuality(true)).toBe("moving");
    });

    test("restores full quality after an interaction settles", () => {
        expect(nextCanvasRenderQuality(false)).toBe("full");
    });

    test("prioritizes overview rendering whenever the canvas is zoomed far out", () => {
        expect(canvasRenderQualityAtScale("full", 0.34)).toBe("overview");
        expect(canvasRenderQualityAtScale("full", 0.5)).toBe("full");
        expect(canvasRenderQualityAtScale("moving", 0.2)).toBe("overview");
    });

    test("shares the overview threshold with viewport virtualization", () => {
        expect(isCanvasOverviewScale(0.4)).toBe(true);
        expect(isCanvasOverviewScale(0.401)).toBe(false);
    });
});
