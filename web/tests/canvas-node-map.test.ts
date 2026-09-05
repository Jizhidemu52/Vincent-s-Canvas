import { expect, test } from "bun:test";

import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x = 0): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y: 0 },
    width: 100,
    height: 100,
});

test("keeps the map identity for content-only node updates", () => {
    const original = { ...node("one"), metadata: { content: "existing content" } };
    const map = createCanvasNodeMap([original]);
    const updated = { ...original, title: "streamed", metadata: { content: "new token" } };

    const refreshed = refreshCanvasNodeMap(map, [updated]);

    expect(refreshed).toBe(map);
    expect(refreshed.get("one")).toBe(updated);
});

test("replaces the map when node geometry or order changes", () => {
    const first = node("first", 0);
    const second = node("second", 240);
    const map = createCanvasNodeMap([first, second]);

    const moved = refreshCanvasNodeMap(map, [first, { ...second, position: { x: 500, y: 0 } }]);
    const reordered = refreshCanvasNodeMap(map, [second, first]);

    expect(moved).not.toBe(map);
    expect(reordered).not.toBe(map);
});

test("drops removed nodes when rebuilding the map", () => {
    const first = node("first");
    const second = node("second", 240);
    const map = createCanvasNodeMap([first, second]);

    const refreshed = refreshCanvasNodeMap(map, [first]);

    expect(refreshed.has("second")).toBe(false);
});

test("replaces the map when a node changes type or joins the resource index", () => {
    const emptyText = node("text");
    const resourceMap = createCanvasNodeMap([emptyText]);
    const typeMap = createCanvasNodeMap([emptyText]);

    const becameResource = refreshCanvasNodeMap(resourceMap, [{ ...emptyText, metadata: { content: "first streamed token" } }]);
    const changedType = refreshCanvasNodeMap(typeMap, [{ ...emptyText, type: CanvasNodeType.Image, metadata: { content: "asset://image" } }]);

    expect(becameResource).not.toBe(resourceMap);
    expect(changedType).not.toBe(typeMap);
});

test("replaces the map when batch membership changes", () => {
    const root = { ...node("root"), type: CanvasNodeType.Image, metadata: { isBatchRoot: true, batchChildIds: ["child-a", "child-b"] } };
    const child = { ...node("child-a", 180), type: CanvasNodeType.Image, metadata: { batchRootId: "root" } };
    const rootMap = createCanvasNodeMap([root, child]);
    const childMap = createCanvasNodeMap([root, child]);

    const changedRoot = refreshCanvasNodeMap(rootMap, [{ ...root, metadata: { ...root.metadata, batchChildIds: ["child-b", "child-a"] } }, child]);
    const changedChild = refreshCanvasNodeMap(childMap, [root, { ...child, metadata: { batchRootId: "other-root" } }]);

    expect(changedRoot).not.toBe(rootMap);
    expect(changedChild).not.toBe(childMap);
});
