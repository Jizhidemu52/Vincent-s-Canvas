import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

const MAX_CONNECTION_GEOMETRY_CACHE_ENTRIES = 1024;

export type CanvasConnectionCurve = {
    start: Position;
    controlOne: Position;
    controlTwo: Position;
    end: Position;
};

export type CanvasConnectionGeometry = {
    d: string;
    segments: CanvasConnectionCurve[];
    bounds: CanvasBounds;
};

export function createConnectionGeometry(from: CanvasNodeData, to: CanvasNodeData): CanvasConnectionGeometry {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const start = { x: startX, y: startY }, end = { x: endX, y: endY };
    let segments: CanvasConnectionCurve[];
    if (endX >= startX) {
        const curvature = Math.max((endX - startX) * 0.5, 50);
        segments = [{ start, controlOne: { x: startX + curvature, y: startY }, controlTwo: { x: endX - curvature, y: endY }, end }];
    } else {
        // A single backwards cubic cuts through both cards. Leave through the
        // source's right side and return to the target's left side via the
        // shorter exterior corridor, with horizontal tangents at every join.
        const clearance = 48;
        const rightX = Math.max(startX, to.position.x + to.width) + clearance;
        const leftX = Math.min(from.position.x, endX) - clearance;
        const topY = Math.min(from.position.y, to.position.y) - clearance;
        const bottomY = Math.max(from.position.y + from.height, to.position.y + to.height) + clearance;
        const routeY = startY + endY - 2 * topY <= 2 * bottomY - startY - endY ? topY : bottomY;
        const outerStart = { x: rightX - clearance / 2, y: routeY };
        const outerEnd = { x: leftX + clearance / 2, y: routeY };
        segments = [
            { start, controlOne: { x: rightX, y: startY }, controlTwo: { x: rightX, y: routeY }, end: outerStart },
            { start: outerStart, controlOne: outerStart, controlTwo: outerEnd, end: outerEnd },
            { start: outerEnd, controlOne: { x: leftX, y: routeY }, controlTwo: { x: leftX, y: endY }, end },
        ];
    }
    const points = segments.flatMap(segment => [segment.start, segment.controlOne, segment.controlTwo, segment.end]);
    return {
        d: `M ${startX} ${startY}${segments.map(({ controlOne, controlTwo, end: tip }) => ` C ${controlOne.x} ${controlOne.y}, ${controlTwo.x} ${controlTwo.y}, ${tip.x} ${tip.y}`).join("")}`,
        segments,
        bounds: {
            minX: Math.min(...points.map(point => point.x)),
            minY: Math.min(...points.map(point => point.y)),
            maxX: Math.max(...points.map(point => point.x)),
            maxY: Math.max(...points.map(point => point.y)),
        },
    };
}

/** Shared by midpoint controls and hit-testing; all routes use these segments. */
export function connectionGeometryPointAt(geometry: CanvasConnectionGeometry, progress: number): Position {
    const scaled = Math.max(0, Math.min(1, progress)) * geometry.segments.length;
    const index = Math.min(geometry.segments.length - 1, Math.floor(scaled));
    const segment = geometry.segments[index];
    const t = scaled - index, inverse = 1 - t;
    return {
        x: inverse ** 3 * segment.start.x + 3 * inverse ** 2 * t * segment.controlOne.x + 3 * inverse * t ** 2 * segment.controlTwo.x + t ** 3 * segment.end.x,
        y: inverse ** 3 * segment.start.y + 3 * inverse ** 2 * t * segment.controlOne.y + 3 * inverse * t ** 2 * segment.controlTwo.y + t ** 3 * segment.end.y,
    };
}

export function connectionGeometryArrow(geometry: CanvasConnectionGeometry, size = 8) {
    const segment = geometry.segments[geometry.segments.length - 1];
    const tip = segment.end;
    const angle = Math.atan2(tip.y - segment.controlTwo.y, tip.x - segment.controlTwo.x);
    const dx = Math.cos(angle) * size, dy = Math.sin(angle) * size;
    return { tip, angle, left: { x: tip.x - dx + dy / 2, y: tip.y - dy - dx / 2 }, right: { x: tip.x - dx - dy / 2, y: tip.y - dy + dx / 2 } };
}

export function createConnectionAdjacency(connections: CanvasConnection[]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    connections.forEach((connection) => {
        [connection.fromNodeId, connection.toNodeId].forEach((nodeId) => {
            const ids = adjacency.get(nodeId) ?? new Set<string>();
            ids.add(connection.id);
            adjacency.set(nodeId, ids);
        });
    });
    return adjacency;
}

export function createConnectionGeometryCache() {
    const entries = new Map<string, { from: CanvasNodeData; to: CanvasNodeData; geometry: CanvasConnectionGeometry }>();
    return {
        get(connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData): CanvasConnectionGeometry {
            const existing = entries.get(connection.id);
            if (existing?.from === from && existing.to === to) return existing.geometry;
            if (entries.size >= MAX_CONNECTION_GEOMETRY_CACHE_ENTRIES) entries.delete(entries.keys().next().value as string);
            const geometry = createConnectionGeometry(from, to);
            entries.set(connection.id, { from, to, geometry });
            return geometry;
        },
    };
}
