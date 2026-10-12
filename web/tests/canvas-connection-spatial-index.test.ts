import { expect, test } from "bun:test";

import { createCanvasConnectionSpatialIndex, refreshCanvasConnectionSpatialIndex, selectCanvasSpatialIndexConnections, type CanvasConnectionSpatialIndex } from "@/lib/canvas/canvas-connection-spatial-index";
import { boundsForCanvasConnection, connectionIntersectsCanvasBounds } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x, y },
    width: 100,
    height: 100,
});

const connection = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

function expectEquivalent(index: CanvasConnectionSpatialIndex, links: CanvasConnection[], nodes: Map<string, CanvasNodeData>, queries: CanvasBounds[]) {
    const rebuilt = createCanvasConnectionSpatialIndex(links, nodes, index.cellSize);
    expect(index.boundsByConnectionId).toEqual(rebuilt.boundsByConnectionId);
    expect(index.connectionsById).toEqual(rebuilt.connectionsById);
    expect(index.connectionOrderById).toEqual(rebuilt.connectionOrderById);
    expect(index.cells).toEqual(rebuilt.cells);
    expect(index.globalConnectionIds).toEqual(rebuilt.globalConnectionIds);
    for (const bounds of queries) {
        const expected = links.filter((link) => {
            const from = nodes.get(link.fromNodeId), to = nodes.get(link.toNodeId);
            return from && to && connectionIntersectsCanvasBounds(from, to, bounds);
        });
        expect(selectCanvasSpatialIndexConnections(index, bounds)).toEqual(expected);
        expect(selectCanvasSpatialIndexConnections(index, bounds, (link) => link.id !== links[0]?.id)).toEqual(expected.filter((link) => link.id !== links[0]?.id));
    }
}

test("returns indexed visible connections in document order while retaining a long crossing curve", () => {
    const nodes = new Map([
        ["left", node("left", -1200, 120)],
        ["right", node("right", 1200, 120)],
        ["outside-left", node("outside-left", -3000, -1200)],
        ["outside-right", node("outside-right", -2400, -1000)],
        ["near-left", node("near-left", 20, 20)],
        ["near-right", node("near-right", 220, 20)],
    ]);
    const connections = [connection("near", "near-left", "near-right"), connection("crossing", "left", "right"), connection("outside", "outside-left", "outside-right")];
    const index = createCanvasConnectionSpatialIndex(connections, nodes, 1024);

    expect(selectCanvasSpatialIndexConnections(index, { minX: 0, minY: 0, maxX: 800, maxY: 500 }).map((item) => item.id)).toEqual(["near", "crossing"]);
});

test("keeps extremely long connections as bounded global candidates", () => {
    const nodes = new Map([
        ["far-left", node("far-left", -200000, 0)],
        ["far-right", node("far-right", 200000, 0)],
    ]);
    const index = createCanvasConnectionSpatialIndex([connection("very-long", "far-left", "far-right")], nodes, 1024);

    expect(index.globalConnectionIds.has("very-long")).toBe(true);
    expect(selectCanvasSpatialIndexConnections(index, { minX: 0, minY: 0, maxX: 800, maxY: 500 }).map((item) => item.id)).toEqual(["very-long"]);
});

test("reuses connection cells when endpoints keep the same geometry", () => {
    const originalLeft = node("left", 0, 0);
    const originalRight = node("right", 600, 0);
    const links = [connection("link", "left", "right")];
    const index = createCanvasConnectionSpatialIndex(links, new Map([["left", originalLeft], ["right", originalRight]]));
    const updatedLinks = links.map((item) => ({ ...item }));

    const refreshed = refreshCanvasConnectionSpatialIndex(
        index,
        updatedLinks,
        new Map([
            ["left", { ...originalLeft, title: "updated" }],
            ["right", { ...originalRight, metadata: { content: "updated" } }],
        ]),
    );

    expect(refreshed.cells).toBe(index.cells);
    expect(refreshed.boundsByConnectionId).toBe(index.boundsByConnectionId);
    expect(refreshed.connectionsById.get("link")).toBe(updatedLinks[0]);
});

test("updates connection cells when an endpoint moves across cells", () => {
    const left = node("left", 0, 0);
    const right = node("right", 600, 0);
    const links = [connection("link", "left", "right")];
    const index = createCanvasConnectionSpatialIndex(links, new Map([["left", left], ["right", right]]));

    const refreshed = refreshCanvasConnectionSpatialIndex(index, links, new Map([["left", left], ["right", { ...right, position: { x: 5000, y: 0 } }]]));

    expect(refreshed.cells).not.toBe(index.cells);
});

test("updates only incident bounds and affected cell sets without mutating the previous index", () => {
    const nodes = new Map([
        ["a", node("a", 0, 0)], ["b", node("b", 800, 160)],
        ["c", node("c", 0, 400)], ["d", node("d", 800, 500)],
        ["far-a", node("far-a", 8000, 8000)], ["far-b", node("far-b", 8800, 8100)],
    ]);
    const links = [connection("moving", "a", "b"), connection("shared-cell", "c", "d"), connection("far", "far-a", "far-b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes, 1024);
    const previousBounds = new Map(index.boundsByConnectionId);
    const previousCells = new Map([...index.cells].map(([key, ids]) => [key, new Set(ids)]));
    const queries = [{ minX: -100, minY: -100, maxX: 1000, maxY: 1000 }, { minX: 4000, minY: 1000, maxX: 6000, maxY: 2000 }];
    const nextNodes = new Map(nodes).set("a", node("a", 4800, 1200)).set("b", node("b", 5600, 1360));
    const refreshed = refreshCanvasConnectionSpatialIndex(index, links, nextNodes);

    expectEquivalent(refreshed, links, nextNodes, queries);
    expect(index.boundsByConnectionId).toEqual(previousBounds);
    expect(index.cells).toEqual(previousCells);
    expect(refreshed.boundsByConnectionId.get("moving")).not.toBe(index.boundsByConnectionId.get("moving"));
    expect(refreshed.boundsByConnectionId.get("shared-cell")).toBe(index.boundsByConnectionId.get("shared-cell"));
    expect(refreshed.boundsByConnectionId.get("far")).toBe(index.boundsByConnectionId.get("far"));
    expect(refreshed.connectionsById).toBe(index.connectionsById);
    expect(refreshed.connectionOrderById).toBe(index.connectionOrderById);
    expect(refreshed.cells.get("0:0")).not.toBe(index.cells.get("0:0"));
    const farKey = [...index.cells].find(([, ids]) => ids.has("far"))![0];
    expect(refreshed.cells.get(farKey)).toBe(index.cells.get(farKey));
    expect(selectCanvasSpatialIndexConnections(index, queries[0]!).map((link) => link.id)).toEqual(["moving", "shared-cell"]);
});

test("deduplicates an edge when both endpoints move and skips unrelated edge geometry", () => {
    const nodes = new Map([
        ["a", node("a", 0, 0)], ["b", node("b", 800, 160)],
        ["c", node("c", 4000, 4000)], ["d", node("d", 4800, 4500)],
    ]);
    const links = [connection("moved", "a", "b"), connection("untouched", "c", "d")];
    const index = createCanvasConnectionSpatialIndex(links, nodes);
    let movedWidthReads = 0, untouchedWidthReads = 0;
    const moved = { ...nodes.get("a")!, position: { x: 100, y: 200 }, get width() { movedWidthReads++; return 100; } };
    const untouched = { ...nodes.get("c")!, get width() { untouchedWidthReads++; return 100; } };
    const nextNodes = new Map(nodes).set("a", moved).set("b", node("b", 900, 300)).set("c", untouched);
    const refreshed = refreshCanvasConnectionSpatialIndex(index, links, nextNodes);

    // One snapshot plus one path calculation, despite both ends being dirty.
    expect(movedWidthReads).toBe(2);
    // An unrelated source is only compared once, not used to calculate a path.
    expect(untouchedWidthReads).toBe(1);
    expect(refreshed.boundsByConnectionId.get("moved")).toEqual(boundsForCanvasConnection(moved, nextNodes.get("b")!));
    expect(refreshed.boundsByConnectionId.get("untouched")).toBe(index.boundsByConnectionId.get("untouched"));
});

test("metadata-only changes and moves within the same cells retain reusable geometry", () => {
    const nodes = new Map([["a", node("a", 0, 0)], ["b", node("b", 800, 160)]]);
    const links = [connection("link", "a", "b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes, 1024);
    const contentOnly = new Map(nodes).set("a", { ...nodes.get("a")!, metadata: { content: "new content" } });
    expect(refreshCanvasConnectionSpatialIndex(index, links, contentOnly)).toBe(index);
    const nextNodes = new Map(nodes).set("a", node("a", 10, 10));
    const refreshed = refreshCanvasConnectionSpatialIndex(index, links, nextNodes);
    expect(refreshed.cells).toBe(index.cells);
    expect(refreshed.boundsByConnectionId.get("link")).not.toBe(index.boundsByConnectionId.get("link"));
    expectEquivalent(refreshed, links, nextNodes, [{ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }]);
});

test("tracks dimensions without rebuilding unchanged path bounds or missing later resizes", () => {
    const nodes = new Map([["a", node("a", 0, 0)], ["b", node("b", 800, 160)]]);
    const links = [connection("link", "a", "b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes);
    // Destination width does not affect its left-side connection anchor.
    const widerDestination = new Map(nodes).set("b", { ...nodes.get("b")!, width: 500 });
    const unchangedPath = refreshCanvasConnectionSpatialIndex(index, links, widerDestination);
    expect(unchangedPath.boundsByConnectionId).toBe(index.boundsByConnectionId);
    expect(unchangedPath.cells).toBe(index.cells);
    expect(refreshCanvasConnectionSpatialIndex(unchangedPath, links, widerDestination)).toBe(unchangedPath);
    const resized = new Map(widerDestination).set("a", { ...nodes.get("a")!, width: 700, height: 900 });
    const refreshed = refreshCanvasConnectionSpatialIndex(unchangedPath, links, resized);
    expectEquivalent(refreshed, links, resized, [{ minX: 0, minY: 0, maxX: 2000, maxY: 2000 }]);
    expect(index.nodeGeometryById.get("a")).toMatchObject({ width: 100, height: 100 });
});

test("restores missing endpoints and removes their edges without losing document order", () => {
    const nodes = new Map([["a", node("a", 0, 0)], ["b", node("b", 800, 160)], ["c", node("c", 0, 400)]]);
    const links = [connection("first-missing", "a", "missing"), connection("second", "c", "b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes, 1024);
    const bounds = { minX: -100, minY: -100, maxX: 2000, maxY: 2000 };
    const restoredNodes = new Map(nodes).set("missing", node("missing", 1000, 600));
    const restored = refreshCanvasConnectionSpatialIndex(index, links, restoredNodes);
    expectEquivalent(restored, links, restoredNodes, [bounds]);
    expect(selectCanvasSpatialIndexConnections(restored, bounds).map((link) => link.id)).toEqual(["first-missing", "second"]);
    expect(index.connectionsById.has("first-missing")).toBe(false);
    const removedNodes = new Map(restoredNodes);
    removedNodes.delete("a");
    const removed = refreshCanvasConnectionSpatialIndex(restored, links, removedNodes);
    expectEquivalent(removed, links, removedNodes, [bounds]);
    expect(restored.boundsByConnectionId.has("first-missing")).toBe(true);
    expect(removed.boundsByConnectionId.has("first-missing")).toBe(false);
    expect(removed.connectionsById.has("first-missing")).toBe(false);
});

test("moves connections between bounded grid cells and global candidates without stale membership", () => {
    const nodes = new Map([["a", node("a", -200000, 0)], ["b", node("b", 200000, 160)]]);
    const links = [connection("link", "a", "b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes, 1024);
    const nearNodes = new Map(nodes).set("b", node("b", -199500, 160));
    const near = refreshCanvasConnectionSpatialIndex(index, links, nearNodes);
    const bounds = [{ minX: -201000, minY: -100, maxX: -199000, maxY: 500 }, { minX: -100, minY: -100, maxX: 1000, maxY: 1000 }];
    expect(index.globalConnectionIds.has("link")).toBe(true);
    expect(near.globalConnectionIds.has("link")).toBe(false);
    expect(near.cells.size).toBeGreaterThan(0);
    expectEquivalent(near, links, nearNodes, bounds);
    const far = refreshCanvasConnectionSpatialIndex(near, links, nodes);
    expectEquivalent(far, links, nodes, bounds);
    expect(far.globalConnectionIds.has("link")).toBe(true);
    expect(far.cells.size).toBe(0);
    expect(near.cells.size).toBeGreaterThan(0);
});

test("refreshes topology and metadata records even when endpoints were previously absent", () => {
    const nodes = new Map([["a", node("a", 0, 0)], ["b", node("b", 800, 160)], ["c", node("c", 1000, 400)]]);
    const links = [connection("orphan", "missing-old", "a"), connection("link", "a", "b")];
    const index = createCanvasConnectionSpatialIndex(links, nodes, 1024);
    const nextLinks = [connection("link", "a", "c"), connection("orphan", "missing-new", "b"), connection("new", "b", "c")];
    const next = refreshCanvasConnectionSpatialIndex(index, nextLinks, nodes);
    const nextNodes = new Map(nodes).set("missing-new", node("missing-new", 50, 500));
    const restored = refreshCanvasConnectionSpatialIndex(next, nextLinks, nextNodes);
    expectEquivalent(restored, nextLinks, nextNodes, [{ minX: -100, minY: -100, maxX: 2000, maxY: 2000 }]);
    const metadataLinks = nextLinks.map((link) => ({ ...link }));
    const metadata = refreshCanvasConnectionSpatialIndex(restored, metadataLinks, nextNodes);
    expect(metadata.cells).toBe(restored.cells);
    expect(metadata.boundsByConnectionId).toBe(restored.boundsByConnectionId);
    expect(metadata.connectionsById.get("orphan")).toBe(metadataLinks[1]);
    expect(index.connectionsById.get("link")).toBe(links[1]);
});

test("matches brute-force bounds and order throughout deterministic dense moves and resizes", () => {
    let nodes = new Map(Array.from({ length: 80 }, (_, i) => [String(i), node(String(i), (i % 10) * 370 - 1400, Math.floor(i / 10) * 290 - 700)]));
    const links = [...nodes.keys()].flatMap((id, i) => Array.from({ length: 12 }, (_, offset) => connection(`${id}-${offset}`, id, String((i + 1 + offset * 3) % nodes.size))));
    let index = createCanvasConnectionSpatialIndex(links, nodes, 256);
    const queries = Array.from({ length: 12 }, (_, i) => ({ minX: -2500 + i * 430, minY: -1800 + i * 270, maxX: -900 + i * 430, maxY: -500 + i * 270 }));
    for (let step = 0; step < 24; step++) {
        const id = String((step * 17) % nodes.size);
        const current = nodes.get(id)!;
        const oldBounds = new Map(index.boundsByConnectionId);
        nodes = new Map(nodes).set(id, { ...current, position: { x: current.position.x + (step % 2 ? 512 : -513), y: current.position.y + (step % 3 ? 256 : -257) }, width: 100 + step * 13, height: 100 + step * 7 });
        const next = refreshCanvasConnectionSpatialIndex(index, links, nodes);
        expectEquivalent(next, links, nodes, queries);
        expect(index.boundsByConnectionId).toEqual(oldBounds);
        index = next;
    }
});
