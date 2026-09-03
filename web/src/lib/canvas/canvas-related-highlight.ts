import type { CanvasConnection } from "@/types/canvas";

export function buildCanvasRelatedHighlight(activeNodeId: string | null, connectionAdjacency: ReadonlyMap<string, ReadonlySet<string>>, connectionById: ReadonlyMap<string, CanvasConnection>) {
    const nodeIds = new Set<string>();
    const connectionIds = new Set<string>();
    if (!activeNodeId) return { nodeIds, connectionIds };

    nodeIds.add(activeNodeId);
    connectionAdjacency.get(activeNodeId)?.forEach((connectionId) => {
        const connection = connectionById.get(connectionId);
        if (!connection) return;
        connectionIds.add(connectionId);
        nodeIds.add(connection.fromNodeId);
        nodeIds.add(connection.toNodeId);
    });
    return { nodeIds, connectionIds };
}
