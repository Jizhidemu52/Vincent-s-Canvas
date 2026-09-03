import { connectionIntersectsCanvasBounds } from "@/lib/canvas/canvas-connection-visibility";
import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

type RefreshVisibleConnectionsForDragOptions = {
    baseVisibleConnections: CanvasConnection[];
    baseVisibleConnectionIds: ReadonlySet<string>;
    affectedConnectionIds: ReadonlySet<string>;
    connectionById: ReadonlyMap<string, CanvasConnection>;
    resolveNode: (nodeId: string) => CanvasNodeData | undefined;
    bounds: CanvasBounds;
    shouldInclude?: (connection: CanvasConnection, from: CanvasNodeData, to: CanvasNodeData) => boolean;
};

export function refreshVisibleConnectionsForDrag({ baseVisibleConnections, baseVisibleConnectionIds, affectedConnectionIds, connectionById, resolveNode, bounds, shouldInclude = () => true }: RefreshVisibleConnectionsForDragOptions): CanvasConnection[] {
    const isVisible = (connection: CanvasConnection) => {
        const from = resolveNode(connection.fromNodeId);
        const to = resolveNode(connection.toNodeId);
        return Boolean(from && to && shouldInclude(connection, from, to) && connectionIntersectsCanvasBounds(from, to, bounds));
    };
    const visibilityChanged = Array.from(affectedConnectionIds).some((id) => {
        const connection = connectionById.get(id);
        if (!connection) return baseVisibleConnectionIds.has(id);
        return baseVisibleConnectionIds.has(id) !== isVisible(connection);
    });
    if (!visibilityChanged) return baseVisibleConnections;
    const retained = baseVisibleConnections.filter((connection) => !affectedConnectionIds.has(connection.id) || (connectionById.has(connection.id) && isVisible(connection)));
    const added = Array.from(affectedConnectionIds)
        .map((id) => connectionById.get(id))
        .filter((connection): connection is CanvasConnection => Boolean(connection && !baseVisibleConnectionIds.has(connection.id) && isVisible(connection)));

    return [...retained, ...added];
}
