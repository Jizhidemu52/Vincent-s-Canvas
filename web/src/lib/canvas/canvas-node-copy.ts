import { nanoid } from "nanoid";

import type { CanvasConnection, CanvasNodeData, CanvasNodeGroup, Position } from "@/types/canvas";

type CanvasNodeGraph = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; groups?: CanvasNodeGroup[] };

/** Both clipboard and context-menu copies own only the selected graph. */
export function copyCanvasNodeGraph(nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[], groups: readonly CanvasNodeGroup[], selectedIds: ReadonlySet<string>): CanvasNodeGraph {
    return {
        nodes: nodes.filter(node => selectedIds.has(node.id)).map(node => ({ ...node, position: { ...node.position }, metadata: node.metadata ? { ...node.metadata } : undefined })),
        connections: connections.filter(connection => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map(connection => ({ ...connection })),
        groups: groups.filter(group => group.nodeIds.length && group.nodeIds.every(id => selectedIds.has(id))).map(group => ({ ...group, nodeIds: [...group.nodeIds] })),
    };
}

export function cloneCanvasNodeGraph(graph: CanvasNodeGraph, offset: Position): CanvasNodeGraph {
    const idMap = new Map<string, string>();
    const nodes = graph.nodes.map((node, index) => {
        const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
        idMap.set(node.id, id);
        return {
            ...node,
            id,
            title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
            position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
            metadata: node.metadata ? { ...node.metadata } : undefined,
        };
    });
    const connections = graph.connections.flatMap((connection, index) => {
        const fromNodeId = idMap.get(connection.fromNodeId);
        const toNodeId = idMap.get(connection.toNodeId);
        if (!fromNodeId || !toNodeId) return [];
        return [{ ...connection, id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId, toNodeId }];
    });

    // A copied style group owns its copied batches, never their source IDs.
    nodes.forEach(node => {
        if (!node.metadata) return;
        if (node.metadata.batchRootId) node.metadata.batchRootId = idMap.get(node.metadata.batchRootId);
        if (node.metadata.batchChildIds) node.metadata.batchChildIds = node.metadata.batchChildIds.flatMap(id => idMap.has(id) ? [idMap.get(id)!] : []);
        if (node.metadata.primaryImageId) node.metadata.primaryImageId = idMap.get(node.metadata.primaryImageId);
    });
    const groups = (graph.groups || []).map(group => ({ ...group, id: `group-${nanoid()}`, nodeIds: group.nodeIds.flatMap(id => idMap.has(id) ? [idMap.get(id)!] : []) }));
    return { nodes, connections, groups };
}
