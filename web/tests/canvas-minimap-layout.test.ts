import { expect, test } from "bun:test";

import { createMinimapNodeRects } from "@/lib/canvas/canvas-minimap-layout";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, x: number, y: number, width: number, height: number): CanvasNodeData => ({ id, type, title: id, position: { x, y }, width, height });

test("creates stable minimap rectangles with type colors and a minimum hit size", () => {
    expect(
        createMinimapNodeRects(
            [node("image", CanvasNodeType.Image, 10, 20, 1, 1), node("text", CanvasNodeType.Text, 40, 50, 20, 30)],
            0.1,
            { x: 3, y: 4 },
            "#64748b",
        ),
    ).toEqual([
        { id: "image", x: 4, y: 6, width: 2, height: 2, color: "#10b981" },
        { id: "text", x: 7, y: 9, width: 2, height: 3, color: "#64748b" },
    ]);
});
