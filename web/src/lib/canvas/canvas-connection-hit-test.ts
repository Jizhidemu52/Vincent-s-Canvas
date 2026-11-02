import { createConnectionGeometry, type CanvasConnectionCurve } from "@/lib/canvas/canvas-connection-geometry";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

type CanvasConnectionHitTestOptions = {
    connections: readonly CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    world: Position;
    tolerance: number;
};

export function findCanvasConnectionHit({ connections, nodeById, world, tolerance }: CanvasConnectionHitTestOptions) {
    const thresholdSquared = Math.max(0, tolerance) ** 2;

    for (let index = connections.length - 1; index >= 0; index -= 1) {
        const connection = connections[index];
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) continue;
        const geometry = createConnectionGeometry(from, to);
        if (!pointMayHitCanvasConnectionBounds(geometry.bounds, world, tolerance)) continue;
        const flatnessSquared = Math.max(0.05, tolerance / 2) ** 2;
        if (geometry.segments.some(segment => hitsCurve(segment, world, thresholdSquared, flatnessSquared))) return connection;
    }
    return null;
}

/**
 * Curve sampling is the expensive part of connection selection. A cubic
 * curve remains inside the bounds of its control points, so points outside an
 * expanded bounds rectangle can never be a hit.
 */
export function pointMayHitCanvasConnectionBounds(bounds: CanvasBounds, world: Position, tolerance: number) {
    const padding = Math.max(0, tolerance);
    return world.x >= bounds.minX - padding && world.x <= bounds.maxX + padding && world.y >= bounds.minY - padding && world.y <= bounds.maxY + padding;
}

function hitsCurve(curve: CanvasConnectionCurve, world: Position, thresholdSquared: number, flatnessSquared: number, depth = 0): boolean {
    const { start, controlOne, controlTwo, end } = curve;
    if (depth >= 12 || Math.max(distanceSquaredToSegment(controlOne, start, end), distanceSquaredToSegment(controlTwo, start, end)) <= flatnessSquared) {
        return distanceSquaredToSegment(world, start, end) <= thresholdSquared;
    }
    const a = midpoint(start, controlOne), b = midpoint(controlOne, controlTwo), c = midpoint(controlTwo, end);
    const d = midpoint(a, b), e = midpoint(b, c), center = midpoint(d, e);
    return hitsCurve({ start, controlOne: a, controlTwo: d, end: center }, world, thresholdSquared, flatnessSquared, depth + 1)
        || hitsCurve({ start: center, controlOne: e, controlTwo: c, end }, world, thresholdSquared, flatnessSquared, depth + 1);
}

const midpoint = (first: Position, second: Position): Position => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });

function distanceSquaredToSegment(point: Position, start: Position, end: Position) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (!dx && !dy) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
    const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx ** 2 + dy ** 2)));
    const nearestX = start.x + dx * progress;
    const nearestY = start.y + dy * progress;
    return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}
