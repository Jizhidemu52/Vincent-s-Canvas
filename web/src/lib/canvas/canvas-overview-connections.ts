import type { CanvasConnection } from "@/types/canvas";

/**
 * An overview must preserve relationships. Only exceptionally dense graphs
 * fall back to the selected path; normal graphs use the batched paint layer.
 */
export function selectCanvasOverviewConnections(connections: CanvasConnection[], activeConnectionIds: ReadonlySet<string>) {
    if (connections.length <= 2000) return connections;
    return connections.filter((connection) => activeConnectionIds.has(connection.id));
}
