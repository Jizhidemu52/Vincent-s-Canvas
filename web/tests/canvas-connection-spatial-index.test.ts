import { expect, test } from "bun:test";

import { createCanvasConnectionSpatialIndex, refreshCanvasConnectionSpatialIndex, selectCanvasSpatialIndexConnections } from "@/lib/canvas/canvas-connection-spatial-index";
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

test("rebuilds connection cells when an endpoint geometry moves", () => {
    const left = node("left", 0, 0);
    const right = node("right", 600, 0);
    const links = [connection("link", "left", "right")];
    const index = createCanvasConnectionSpatialIndex(links, new Map([["left", left], ["right", right]]));

    const refreshed = refreshCanvasConnectionSpatialIndex(index, links, new Map([["left", left], ["right", { ...right, position: { x: 5000, y: 0 } }]]));

    expect(refreshed.cells).not.toBe(index.cells);
});
