import { expect, test } from "bun:test";

import { drawMinimapNodeRects } from "@/lib/canvas/canvas-minimap-drawing";

test("draws minimap nodes in their layout order with a shared opacity", () => {
    const fills: Array<{ color: string; alpha: number; x: number; y: number; width: number; height: number }> = [];
    const context = {
        fillStyle: "",
        globalAlpha: 1,
        fillRect(x: number, y: number, width: number, height: number) {
            fills.push({ color: this.fillStyle as string, alpha: this.globalAlpha as number, x, y, width, height });
        },
    };

    drawMinimapNodeRects(context as unknown as CanvasRenderingContext2D, [
        { id: "first", x: 12, y: 18, width: 4, height: 5, color: "#ff6b35" },
        { id: "second", x: 24, y: 30, width: 6, height: 7, color: "#5b8def" },
    ]);

    expect(context.globalAlpha).toBe(1);
    expect(fills).toEqual([
        { color: "#ff6b35", alpha: 0.8, x: 12, y: 18, width: 4, height: 5 },
        { color: "#5b8def", alpha: 0.8, x: 24, y: 30, width: 6, height: 7 },
    ]);
});
