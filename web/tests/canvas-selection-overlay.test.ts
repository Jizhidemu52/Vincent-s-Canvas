import { expect, test } from "bun:test";

import { canvasSelectionOverlayRect } from "@/components/canvas/canvas-selection-overlay";

test("normalizes a reverse-direction selection into a drawable overlay rectangle", () => {
    expect(
        canvasSelectionOverlayRect({
            startWorldX: 640,
            startWorldY: 420,
            currentWorldX: 180,
            currentWorldY: 120,
        }),
    ).toEqual({ left: 180, top: 120, width: 460, height: 300 });
});

test("keeps a zero-area selection visible at its starting point", () => {
    expect(
        canvasSelectionOverlayRect({
            startWorldX: 240,
            startWorldY: 160,
            currentWorldX: 240,
            currentWorldY: 160,
        }),
    ).toEqual({ left: 240, top: 160, width: 0, height: 0 });
});
