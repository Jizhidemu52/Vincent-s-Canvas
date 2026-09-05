import { describe, expect, test } from "bun:test";

import { createCanvasMinimapGeometryCache } from "@/lib/canvas/canvas-minimap-geometry-cache";
import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x = 0): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y: 0 }, width: 120, height: 160 });

describe("canvas minimap geometry cache", () => {
    test("retains the geometry list when batch results only update node content", () => {
        const cache = createCanvasMinimapGeometryCache();
        const selected = node("selected");
        const first = cache.select([selected, node("other", 200)]);
        const second = cache.select([{ ...selected, metadata: { status: "success", content: "result" } }, node("other", 200)]);

        expect(second).toBe(first);
    });

    test("updates the geometry list when a node moves, resizes, or changes type", () => {
        const cache = createCanvasMinimapGeometryCache();
        const source = node("source");
        const first = cache.select([source]);
        const moved = cache.select([{ ...source, position: { x: 80, y: 0 } }]);
        const changedType = cache.select([{ ...source, type: CanvasNodeType.Video }]);

        expect(moved).not.toBe(first);
        expect(changedType).not.toBe(moved);
    });

    test("trusts an unchanged live node map and skips content-stream scans", () => {
        const cache = createCanvasMinimapGeometryCache();
        const source = { ...node("source"), metadata: { content: "existing" } };
        const nodeMap = createCanvasNodeMap([source]);
        const first = cache.select([source], nodeMap);
        const updated = { ...source, title: "streamed", metadata: { content: "next token" } };

        expect(refreshCanvasNodeMap(nodeMap, [updated])).toBe(nodeMap);
        const staleArray = [{ ...updated, position: { x: 900, y: 0 } }];
        const second = cache.select(staleArray, nodeMap);

        expect(second).toBe(first);
        expect(second[0]?.position.x).toBe(0);
    });
});
