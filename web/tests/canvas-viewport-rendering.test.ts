import { expect, test } from "bun:test";

import { canvasViewportContentStyle } from "@/lib/canvas/canvas-viewport-rendering";

test("promotes the canvas content layer only while the viewport is moving", () => {
    expect(canvasViewportContentStyle({ x: 120, y: -40, k: 0.5 }, true)).toEqual({
        transform: "translate(120px, -40px) scale(0.5)",
        "--canvas-node-ui-scale": 2,
        willChange: "transform",
    });
    expect(canvasViewportContentStyle({ x: 120, y: -40, k: 0.5 }, false)).toEqual({
        transform: "translate(120px, -40px) scale(0.5)",
        "--canvas-node-ui-scale": 2,
        willChange: "auto",
    });
});

test("keeps image frame and handle sizes independent of the canvas zoom", () => {
    for (const zoom of [0.25, 0.5, 1, 2, 4]) {
        const style = canvasViewportContentStyle({ x: 0, y: 0, k: zoom }, false);
        expect(style["--canvas-node-ui-scale"] * zoom).toBe(1);
    }
});
