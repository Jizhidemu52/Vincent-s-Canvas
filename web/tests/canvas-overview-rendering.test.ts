import { expect, test } from "bun:test";

import { filterCanvasOverviewRenderNodes } from "@/lib/canvas/canvas-overview-rendering";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 80 });

test("leaves selected nodes out of the overview canvas while keeping their DOM counterpart available", () => {
    const nodes = [node("a"), node("b"), node("c")];
    expect(filterCanvasOverviewRenderNodes(nodes, new Set(["b"])).map((item) => item.id)).toEqual(["a", "c"]);
});

test("does not allocate a replacement list when no nodes are selected", () => {
    const nodes = [node("a")];
    expect(filterCanvasOverviewRenderNodes(nodes, new Set())).toBe(nodes);
});
