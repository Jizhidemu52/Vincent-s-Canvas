import { describe, expect, test } from "bun:test";

import { nextCanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

describe("canvas render quality", () => {
    test("uses the moving quality while an interaction is active", () => {
        expect(nextCanvasRenderQuality(true)).toBe("moving");
    });

    test("restores full quality after an interaction settles", () => {
        expect(nextCanvasRenderQuality(false)).toBe("full");
    });
});
