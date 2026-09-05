import { expect, test } from "bun:test";

import { canvasViewportContentStyle } from "@/lib/canvas/canvas-viewport-rendering";

test("promotes the canvas content layer only while the viewport is moving", () => {
    expect(canvasViewportContentStyle({ x: 120, y: -40, k: 0.5 }, true)).toEqual({
        transform: "translate(120px, -40px) scale(0.5)",
        willChange: "transform",
    });
    expect(canvasViewportContentStyle({ x: 120, y: -40, k: 0.5 }, false)).toEqual({
        transform: "translate(120px, -40px) scale(0.5)",
        willChange: "auto",
    });
});
