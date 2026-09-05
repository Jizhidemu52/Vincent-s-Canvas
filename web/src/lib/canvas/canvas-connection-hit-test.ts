import { createConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";
import { boundsForCanvasConnection } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

type CanvasConnectionHitTestOptions = {
    connections: readonly CanvasConnection[];
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    world: Position;
    tolerance: number;
};

const curveSegments = 24;

export function findCanvasConnectionHit({ connections, nodeById, world, tolerance }: CanvasConnectionHitTestOptions) {
    const thresholdSquared = Math.max(0, tolerance) ** 2;

    for (let index = connections.length - 1; index >= 0; index -= 1) {
        const connection = connections[index];
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        if (!from || !to) continue;
        if (!pointMayHitCanvasConnectionBounds(boundsForCanvasConnection(from, to), world, tolerance)) continue;
        const points = createConnectionGeometry(from, to).points;
        let previous = points.start;
        for (let segment = 1; segment <= curveSegments; segment += 1) {
            const current = pointOnCubic(points, segment / curveSegments);
            if (distanceSquaredToSegment(world, previous, current) <= thresholdSquared) return connection;
            previous = current;
        }
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

function pointOnCubic(
    points: ReturnType<typeof createConnectionGeometry>["points"],
    progress: number,
): Position {
    const inverse = 1 - progress;
    return {
        x: inverse ** 3 * points.start.x + 3 * inverse ** 2 * progress * points.controlOne.x + 3 * inverse * progress ** 2 * points.controlTwo.x + progress ** 3 * points.end.x,
        y: inverse ** 3 * points.start.y + 3 * inverse ** 2 * progress * points.controlOne.y + 3 * inverse * progress ** 2 * points.controlTwo.y + progress ** 3 * points.end.y,
    };
}

function distanceSquaredToSegment(point: Position, start: Position, end: Position) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (!dx && !dy) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
    const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx ** 2 + dy ** 2)));
    const nearestX = start.x + dx * progress;
    const nearestY = start.y + dy * progress;
    return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}
