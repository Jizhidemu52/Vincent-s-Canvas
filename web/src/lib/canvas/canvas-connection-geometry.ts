import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CanvasConnectionGeometry = { d: string; bounds: CanvasBounds };

export function createConnectionGeometry(from: CanvasNodeData, to: CanvasNodeData): CanvasConnectionGeometry {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    const controlOneX = startX + curvature;
    const controlTwoX = endX - curvature;

    return {
        d: `M ${startX} ${startY} C ${controlOneX} ${startY}, ${controlTwoX} ${endY}, ${endX} ${endY}`,
        bounds: {
            minX: Math.min(startX, controlOneX, controlTwoX, endX),
            minY: Math.min(startY, endY),
            maxX: Math.max(startX, controlOneX, controlTwoX, endX),
            maxY: Math.max(startY, endY),
        },
    };
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
            const geometry = createConnectionGeometry(from, to);
            entries.set(connection.id, { from, to, geometry });
            return geometry;
        },
    };
}
