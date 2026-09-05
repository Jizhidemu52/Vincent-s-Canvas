import type { CanvasConnection } from "@/types/canvas";

/**
 * In a far overview, a dense web of ordinary links costs paint time without
 * adding useful context. Keep only the selected path, which preserves the
 * user's current relationship while they navigate back to detail.
 */
export function selectCanvasOverviewConnections(connections: CanvasConnection[], activeConnectionIds: ReadonlySet<string>) {
    if (!activeConnectionIds.size) return [];
    return connections.filter((connection) => activeConnectionIds.has(connection.id));
}
