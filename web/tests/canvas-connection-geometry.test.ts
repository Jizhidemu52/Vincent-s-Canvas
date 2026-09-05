import { expect, test } from "bun:test";

import { createConnectionAdjacency, createConnectionGeometryCache } from "@/lib/canvas/canvas-connection-geometry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Text, title: "source", position: { x: 0, y: 0 }, width: 100, height: 50 };
const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Text, title: "target", position: { x: 300, y: 0 }, width: 100, height: 50 };

test("caches geometry by connection and endpoint references", () => {
    const connection: CanvasConnection = { id: "source-target", fromNodeId: source.id, toNodeId: target.id };
    const cache = createConnectionGeometryCache();
    const first = cache.get(connection, source, target);
    const second = cache.get(connection, source, target);
    const moved = cache.get(connection, { ...source, position: { x: 40, y: 0 } }, target);

    expect(first).toBe(second);
    expect(moved).not.toBe(first);
    expect(first.d).toContain("M 100 25 C");
});

test("bounds cached connection geometry during a long pan across the canvas", () => {
    const cache = createConnectionGeometryCache();
    const firstConnection: CanvasConnection = { id: "connection-0", fromNodeId: source.id, toNodeId: target.id };
    const firstGeometry = cache.get(firstConnection, source, target);

    for (let index = 1; index <= 1024; index += 1) {
        cache.get({ id: `connection-${index}`, fromNodeId: source.id, toNodeId: target.id }, source, target);
    }

    expect(cache.get(firstConnection, source, target)).not.toBe(firstGeometry);
});

test("indexes only adjacent connection ids for a node", () => {
    const connections: CanvasConnection[] = [
        { id: "ab", fromNodeId: "a", toNodeId: "b" },
        { id: "cd", fromNodeId: "c", toNodeId: "d" },
    ];

    expect(createConnectionAdjacency(connections).get("a")).toEqual(new Set(["ab"]));
});
