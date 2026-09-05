import { expect, test } from "bun:test";

import { CANVAS_WHEEL_PASSTHROUGH_SELECTOR, shouldCanvasCaptureWheel } from "@/lib/canvas/canvas-wheel-target";

test("keeps canvas zoom disabled over interactive surfaces", () => {
    let selector = "";
    const interactiveTarget = {
        closest(value: string) {
            selector = value;
            return {} as Element;
        },
    } as unknown as Element;

    expect(shouldCanvasCaptureWheel(interactiveTarget)).toBe(false);
    expect(selector).toBe(CANVAS_WHEEL_PASSTHROUGH_SELECTOR);
});

test("captures wheel input only when it originates from the canvas", () => {
    const canvasTarget = { closest: () => null } as unknown as Element;

    expect(shouldCanvasCaptureWheel(canvasTarget)).toBe(true);
    expect(shouldCanvasCaptureWheel(null)).toBe(true);
});
