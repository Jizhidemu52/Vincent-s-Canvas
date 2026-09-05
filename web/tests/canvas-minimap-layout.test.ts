import { expect, test } from "bun:test";

import { createMinimapLayout, createMinimapNodeRects, refreshMinimapLayout } from "@/lib/canvas/canvas-minimap-layout";
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

test("reuses the minimap layout when only node content changes", () => {
    const nodes = [node("image", CanvasNodeType.Image, 10, 20, 80, 120), node("text", CanvasNodeType.Text, 340, 50, 160, 90)];
    const layout = createMinimapLayout(nodes, 240, 160);
    const contentOnlyUpdate = nodes.map((current) => ({ ...current, title: `${current.title} updated`, metadata: { content: "new prompt", status: "loading" as const } }));

    const refreshed = refreshMinimapLayout(layout, contentOnlyUpdate, 240, 160);

    expect(refreshed).toBe(layout);
    expect(refreshed.nodes).toBe(layout.nodes);
});

test("rebuilds the minimap layout after a node geometry change", () => {
    const nodes = [node("image", CanvasNodeType.Image, 10, 20, 80, 120), node("text", CanvasNodeType.Text, 340, 50, 160, 90)];
    const layout = createMinimapLayout(nodes, 240, 160);
    const moved = nodes.map((current) => (current.id === "text" ? { ...current, position: { x: 940, y: 50 } } : current));

    const refreshed = refreshMinimapLayout(layout, moved, 240, 160);

    expect(refreshed).not.toBe(layout);
    expect(refreshed.worldBounds.w).toBeGreaterThan(layout.worldBounds.w);
});
