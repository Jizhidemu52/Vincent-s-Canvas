import { connectionIntersectsCanvasBounds } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type RefreshVisibleConnectionsForDragOptions = {
    baseVisibleConnections: CanvasConnection[];
    affectedConnectionIds: ReadonlySet<string>;
    connectionById: ReadonlyMap<string, CanvasConnection>;
    nodeById: ReadonlyMap<string, CanvasNodeData>;
    bounds: CanvasBounds;
    shouldInclude?: (connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData) => boolean;
};

export function refreshVisibleConnectionsForDrag({ baseVisibleConnections, affectedConnectionIds, connectionById, nodeById, bounds, shouldInclude = () => true }: RefreshVisibleConnectionsForDragOptions): CanvasConnection[] {
    const baseVisibleIds = new Set(baseVisibleConnections.map((connection) => connection.id));
    const isVisible = (connection: CanvasConnection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        return Boolean(from && to && shouldInclude(connection, from, to) && connectionIntersectsCanvasBounds(from, to, bounds));
    };
    const retained = baseVisibleConnections.filter((connection) => !affectedConnectionIds.has(connection.id) || isVisible(connection));
    const added = Array.from(affectedConnectionIds)
        .map((id) => connectionById.get(id))
        .filter((connection): connection is CanvasConnection => Boolean(connection && !baseVisibleIds.has(connection.id) && isVisible(connection)));

    return [...retained, ...added];
}
