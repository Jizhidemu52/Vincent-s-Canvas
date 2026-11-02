import { expect, test } from "bun:test";

import { connectionGeometryArrow, connectionGeometryPointAt, createConnectionAdjacency, createConnectionGeometry, createConnectionGeometryCache } from "@/lib/canvas/canvas-connection-geometry";
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

test("backward links route outside both endpoint cards and share the exact endpoint direction", () => {
    const from = { ...source, position: { x: 600, y: 200 }, width: 240, height: 280 };
    for (const y of [200, -100, 400]) {
        const to = { ...target, position: { x: 0, y }, width: 240, height: 180 };
        const geometry = createConnectionGeometry(from, to);
        expect(geometry.segments).toHaveLength(3);
        expect(geometry.d.match(/ C /g)).toHaveLength(3);
        expect(connectionGeometryPointAt(geometry, 0)).toEqual({ x: 840, y: 340 });
        expect(connectionGeometryPointAt(geometry, 1)).toEqual({ x: 0, y: y + 90 });
        const midpoint = connectionGeometryPointAt(geometry, 0.5);
        expect(midpoint.y < Math.min(from.position.y, y) || midpoint.y > Math.max(from.position.y + from.height, y + to.height)).toBe(true);
        expect(connectionGeometryArrow(geometry).angle).toBe(0);
        for (let sample = 1; sample < 300; sample++) {
            const point = connectionGeometryPointAt(geometry, sample / 300);
            for (const card of [from, to]) expect(point.x > card.position.x && point.x < card.position.x + card.width && point.y > card.position.y && point.y < card.position.y + card.height).toBe(false);
            expect(point.x).toBeGreaterThanOrEqual(geometry.bounds.minX);
            expect(point.x).toBeLessThanOrEqual(geometry.bounds.maxX);
            expect(point.y).toBeGreaterThanOrEqual(geometry.bounds.minY - 1e-9);
            expect(point.y).toBeLessThanOrEqual(geometry.bounds.maxY + 1e-9);
        }
    }
});

test("forward links keep their existing cubic and clamp point sampling to endpoints", () => {
    const geometry = createConnectionGeometry(source, target);
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.d).toBe("M 100 25 C 200 25, 200 25, 300 25");
    expect(connectionGeometryPointAt(geometry, 0.5)).toEqual({ x: 200, y: 25 });
    expect(connectionGeometryPointAt(geometry, -5)).toEqual(geometry.segments[0].start);
    expect(connectionGeometryPointAt(geometry, 5)).toEqual(geometry.segments[0].end);
});
