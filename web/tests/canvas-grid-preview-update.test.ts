import { expect, test } from "bun:test";

import { canvasGridPreviewUpdate } from "@/lib/canvas/canvas-grid-preview-update";

test("does not rewrite an unchanged grid size while panning", () => {
    const first = canvasGridPreviewUpdate("dots", { x: 20, y: 33, k: 1 }, null);
    const pan = canvasGridPreviewUpdate("dots", { x: 36, y: 49, k: 1 }, first.gridSize);
    const zoom = canvasGridPreviewUpdate("dots", { x: 36, y: 49, k: 1.5 }, first.gridSize);

    expect(first).toEqual({ gridSize: "16px", backgroundPosition: "4px 1px" });
    expect(pan).toEqual({ gridSize: null, backgroundPosition: "4px 1px" });
    expect(zoom).toEqual({ gridSize: "24px", backgroundPosition: "12px 1px" });
});

test("does not produce a grid update for a blank canvas", () => {
    expect(canvasGridPreviewUpdate("blank", { x: 20, y: 33, k: 1 }, null)).toBeNull();
});
