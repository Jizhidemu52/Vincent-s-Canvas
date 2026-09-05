import { describe, expect, test } from "bun:test";

import { boundsForViewport, createCanvasSpatialIndex, queryCanvasSpatialIndex, refreshCanvasSpatialGeometryIndex, refreshCanvasSpatialIndex, selectCanvasSpatialIndexNodes, selectIndexedCanvasNodes } from "@/lib/canvas/canvas-spatial-index";
import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y },
    width,
    height,
});

describe("canvas spatial index", () => {
    test("returns each node once when it spans multiple grid cells", () => {
        const index = createCanvasSpatialIndex([node("wide", 900, 0, 300, 100), node("negative", -80, -80)], 1024);

        expect(queryCanvasSpatialIndex(index, { minX: 800, minY: -100, maxX: 1300, maxY: 200 })).toEqual(["wide"]);
    });

    test("finds a node stored in negative coordinate cells", () => {
        const index = createCanvasSpatialIndex([node("negative", -180, -140, 80, 80)], 1024);

        expect(queryCanvasSpatialIndex(index, { minX: -200, minY: -200, maxX: -90, maxY: -40 })).toEqual(["negative"]);
    });

    test("converts a translated viewport and padding into world bounds", () => {
        expect(boundsForViewport({ x: 200, y: 100, k: 2 }, 400, 200, 50)).toEqual({ minX: -150, minY: -100, maxX: 150, maxY: 100 });
    });

    test("keeps stacking order while applying a node visibility predicate", () => {
        const nodes = [node("far", 4000, 0), node("visible", 80, 40), node("hidden", 160, 40)];
        const index = createCanvasSpatialIndex(nodes, 1024);

        expect(selectIndexedCanvasNodes(nodes, index, { minX: 0, minY: 0, maxX: 400, maxY: 400 }, (candidate) => candidate.id !== "hidden").map((candidate) => candidate.id)).toEqual(["visible"]);
    });

    test("returns visible candidates in document order directly from the index", () => {
        const nodes = [node("later", 2100, 0), node("earlier", 0, 0), node("outside", 5000, 0)];
        const index = createCanvasSpatialIndex(nodes, 1024);

        expect(selectCanvasSpatialIndexNodes(index, { minX: -50, minY: -50, maxX: 2400, maxY: 200 }).map((candidate) => candidate.id)).toEqual(["later", "earlier"]);
    });

    test("reuses the spatial grid when only node content changes", () => {
        const original = { ...node("visible", 80, 40), metadata: { content: "existing" } };
        const index = createCanvasSpatialIndex([original], 1024);
        const updated = { ...original, title: "renamed", metadata: { content: "changed" } };

        const refreshed = refreshCanvasSpatialIndex(index, [updated]);

        expect(refreshed.cells).toBe(index.cells);
        expect(refreshed.boundsByNodeId).toBe(index.boundsByNodeId);
        expect(refreshed.nodesById.get("visible")).toBe(updated);
    });

    test("keeps a geometry-only index fully stable for content updates", () => {
        const original = node("visible", 80, 40);
        const index = createCanvasSpatialIndex([original], 1024);
        const updated = { ...original, title: "streamed", metadata: { content: "new token", status: "loading" as const } };

        expect(refreshCanvasSpatialGeometryIndex(index, [updated])).toBe(index);
    });

    test("trusts an unchanged live node map and skips a redundant geometry scan", () => {
        const original = { ...node("visible", 80, 40), metadata: { content: "existing" } };
        const nodeMap = createCanvasNodeMap([original]);
        const index = createCanvasSpatialIndex([original], 1024, nodeMap);
        const updated = { ...original, title: "streamed", metadata: { content: "next token" } };

        expect(refreshCanvasNodeMap(nodeMap, [updated])).toBe(nodeMap);
        const staleArray = [{ ...updated, position: { x: 9999, y: 40 } }];
        expect(refreshCanvasSpatialGeometryIndex(index, staleArray, nodeMap)).toBe(index);
        expect(selectCanvasSpatialIndexNodes(index, { minX: 0, minY: 0, maxX: 300, maxY: 300 })[0]).toBe(updated);
    });

    test("keeps the full index stable when supplied node map only changes content", () => {
        const original = { ...node("visible", 80, 40), metadata: { content: "existing" } };
        const nodeMap = createCanvasNodeMap([original]);
        const index = createCanvasSpatialIndex([original], 1024, nodeMap);
        const updated = { ...original, metadata: { content: "streamed" } };

        expect(refreshCanvasNodeMap(nodeMap, [updated])).toBe(nodeMap);
        const refreshed = refreshCanvasSpatialIndex(index, [updated], nodeMap);

        expect(refreshed).toBe(index);
        expect(selectCanvasSpatialIndexNodes(refreshed, { minX: 0, minY: 0, maxX: 300, maxY: 300 })[0]).toBe(updated);
    });

    test("updates only changed records while keeping a multi-node content map stable", () => {
        const first = { ...node("first", 80, 40), metadata: { content: "old" } };
        const second = { ...node("second", 180, 40), metadata: { content: "unchanged" } };
        const nodeMap = createCanvasNodeMap([first, second]);
        const changedFirst = { ...first, metadata: { content: "new" } };

        const refreshed = refreshCanvasNodeMap(nodeMap, [changedFirst, second]);

        expect(refreshed).toBe(nodeMap);
        expect(refreshed.get("first")).toBe(changedFirst);
        expect(refreshed.get("second")).toBe(second);
    });

    test("refreshes the live node map when a batch root changes child visibility", () => {
        const original = {
            ...node("batch-root", 80, 40),
            metadata: { isBatchRoot: true, imageBatchExpanded: false, batchChildIds: ["batch-child"] },
        };
        const nodeMap = createCanvasNodeMap([original]);
        const expanded = { ...original, metadata: { ...original.metadata, imageBatchExpanded: true } };

        const refreshed = refreshCanvasNodeMap(nodeMap, [expanded]);

        expect(refreshed).not.toBe(nodeMap);
        expect(refreshed.get("batch-root")).toBe(expanded);
    });

    test("rebuilds the spatial grid after a node geometry change", () => {
        const original = node("visible", 80, 40);
        const index = createCanvasSpatialIndex([original], 1024);

        const refreshed = refreshCanvasSpatialIndex(index, [{ ...original, position: { x: 4096, y: 40 } }]);

        expect(refreshed.cells).not.toBe(index.cells);
        expect(queryCanvasSpatialIndex(refreshed, { minX: 4000, minY: 0, maxX: 4300, maxY: 200 })).toEqual(["visible"]);
    });
});
