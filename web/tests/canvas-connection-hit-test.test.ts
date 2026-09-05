import { expect, test } from "bun:test";

import { findCanvasConnectionHit, pointMayHitCanvasConnectionBounds } from "@/lib/canvas/canvas-connection-hit-test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, x: number, y: number): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width: 100, height: 100 });
const connection = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

test("finds a cubic connection near the pointer without an SVG hit path", () => {
    const source = node("source", 0, 0);
    const target = node("target", 300, 0);
    const item = connection("connection", source.id, target.id);
    const nodeById = new Map([[source.id, source], [target.id, target]]);

    expect(findCanvasConnectionHit({ connections: [item], nodeById, world: { x: 200, y: 50 }, tolerance: 6 })).toBe(item);
    expect(findCanvasConnectionHit({ connections: [item], nodeById, world: { x: 200, y: 80 }, tolerance: 6 })).toBeNull();
});

test("prefers the last rendered overlapping connection", () => {
    const source = node("source", 0, 0);
    const target = node("target", 300, 0);
    const first = connection("first", source.id, target.id);
    const top = connection("top", source.id, target.id);
    const nodeById = new Map([[source.id, source], [target.id, target]]);

    expect(findCanvasConnectionHit({ connections: [first, top], nodeById, world: { x: 200, y: 50 }, tolerance: 6 })).toBe(top);
});

test("rejects points outside a connection's tolerance-expanded bounds before curve sampling", () => {
    expect(pointMayHitCanvasConnectionBounds({ minX: 100, minY: 40, maxX: 300, maxY: 80 }, { x: 91, y: 50 }, 10)).toBe(true);
    expect(pointMayHitCanvasConnectionBounds({ minX: 100, minY: 40, maxX: 300, maxY: 80 }, { x: 89, y: 50 }, 10)).toBe(false);
    expect(pointMayHitCanvasConnectionBounds({ minX: 100, minY: 40, maxX: 300, maxY: 80 }, { x: 200, y: 95 }, 10)).toBe(false);
});
