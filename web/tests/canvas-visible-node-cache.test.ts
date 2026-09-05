import { expect, test } from "bun:test";

import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { createCanvasSpatialIndex, refreshCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { createCanvasVisibleNodeCache } from "@/lib/canvas/canvas-visible-node-cache";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 400 };
const node = (id: string, x: number, content = "content"): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x, y: 0 }, width: 100, height: 100, metadata: { content } });

test("reuses the visible list when streamed content changes off screen", () => {
    const visible = node("visible", 80);
    const offscreen = node("offscreen", 1600);
    const nodeById = createCanvasNodeMap([visible, offscreen]);
    const index = createCanvasSpatialIndex([visible, offscreen], 1024, nodeById);
    const cache = createCanvasVisibleNodeCache();
    const roots = new Map<string, CanvasNodeData>();
    const first = cache.select(index, bounds, roots);
    const changedOffscreen = { ...offscreen, metadata: { content: "updated elsewhere" } };

    expect(refreshCanvasNodeMap(nodeById, [visible, changedOffscreen])).toBe(nodeById);
    const refreshedIndex = refreshCanvasSpatialIndex(index, [visible, changedOffscreen], nodeById);
    expect(cache.select(refreshedIndex, bounds, roots)).toBe(first);
});

test("refreshes only visible records when streamed content changes on screen", () => {
    const visible = node("visible", 80);
    const offscreen = node("offscreen", 1600);
    const nodeById = createCanvasNodeMap([visible, offscreen]);
    const index = createCanvasSpatialIndex([visible, offscreen], 1024, nodeById);
    const cache = createCanvasVisibleNodeCache();
    const roots = new Map<string, CanvasNodeData>();
    cache.select(index, bounds, roots);
    const changedVisible = { ...visible, metadata: { content: "streamed" } };

    expect(refreshCanvasNodeMap(nodeById, [changedVisible, offscreen])).toBe(nodeById);
    const refreshedIndex = refreshCanvasSpatialIndex(index, [changedVisible, offscreen], nodeById);
    const next = cache.select(refreshedIndex, bounds, roots);

    expect(next).toEqual([changedVisible]);
});

test("requeries the spatial index when viewport bounds change", () => {
    const firstNode = node("first", 80);
    const secondNode = node("second", 1400);
    const index = createCanvasSpatialIndex([firstNode, secondNode], 1024);
    const cache = createCanvasVisibleNodeCache();
    const roots = new Map<string, CanvasNodeData>();

    expect(cache.select(index, bounds, roots).map((item) => item.id)).toEqual(["first"]);
    expect(cache.select(index, { minX: 1200, minY: 0, maxX: 1800, maxY: 400 }, roots).map((item) => item.id)).toEqual(["second"]);
});
