import { nanoid } from "nanoid";

import type { CanvasConnection, CanvasNodeData, CanvasNodeGroup, Position } from "@/types/canvas";

export type CanvasNodeGraph = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; groups?: CanvasNodeGroup[] };

/** Both clipboard and context-menu copies own only the selected graph. */
export function copyCanvasNodeGraph(nodes: readonly CanvasNodeData[], connections: readonly CanvasConnection[], groups: readonly CanvasNodeGroup[], selectedIds: ReadonlySet<string>): CanvasNodeGraph {
    return {
        nodes: nodes.filter(node => selectedIds.has(node.id)).map(node => structuredClone(node)),
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
            metadata: node.metadata ? structuredClone(node.metadata) : undefined,
        };
    });
    const connections = graph.connections.flatMap((connection, index) => {
        const fromNodeId = idMap.get(connection.fromNodeId);
        const toNodeId = idMap.get(connection.toNodeId);
        if (!fromNodeId || !toNodeId) return [];
        return [{ ...connection, id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId, toNodeId }];
    });

    // A copied style group owns its copied batches, never their source IDs.
    const remapReferenceKey = (key: string) => key.replace(/^(node|canvas|source):(.+)$/, (original, prefix: string, id: string) => idMap.has(id) ? `${prefix}:${idMap.get(id)}` : original);
    const remapMention = (text: string) => text.replace(/@\[node:([^\]]+)\]/g, (original, id: string) => {
        const next = idMap.get(id) || remapReferenceKey(id);
        return next !== id ? `@[node:${next}]` : original;
    });
    nodes.forEach(node => {
        if (!node.metadata) return;
        // A copy is a new draft/result, never another owner of a billed request.
        delete node.metadata.imageTask;
        delete node.metadata.mediaTask;
        delete node.metadata.textRequestId;
        delete node.metadata.sourceTaskId;
        delete node.metadata.videoTaskId;
        delete node.metadata.videoTaskCanRecover;
        delete node.metadata.generationSubmissionUncertain;
        delete node.metadata.errorDetails;
        node.metadata.status = node.metadata.content ? "success" : "idle";
        if (node.metadata.batchRootId) node.metadata.batchRootId = idMap.get(node.metadata.batchRootId);
        if (node.metadata.batchChildIds) node.metadata.batchChildIds = node.metadata.batchChildIds.flatMap(id => idMap.has(id) ? [idMap.get(id)!] : []);
        if (node.metadata.primaryImageId) node.metadata.primaryImageId = idMap.get(node.metadata.primaryImageId);
        const origin = node.metadata.generationOrigin;
        if (origin) {
            const sourceNodeId = idMap.get(origin.sourceNodeId);
            const configNodeId = origin.configNodeId ? idMap.get(origin.configNodeId) : undefined;
            node.metadata.generationOrigin = sourceNodeId && (!origin.configNodeId || configNodeId) ? { ...origin, sourceNodeId, configNodeId } : undefined;
        }
        if (node.metadata.prompt) node.metadata.prompt = remapMention(node.metadata.prompt);
        if (node.metadata.composerContent) node.metadata.composerContent = remapMention(node.metadata.composerContent);
        if (node.metadata.draftPrompt) node.metadata.draftPrompt = remapMention(node.metadata.draftPrompt);
        if (node.metadata.manualImageReferences) node.metadata.manualImageReferences = node.metadata.manualImageReferences.map(reference => ({
            ...reference,
            id: reference.origin === "canvas" ? idMap.get(reference.id) || reference.id : reference.id,
            sourceNodeId: reference.sourceNodeId ? idMap.get(reference.sourceNodeId) : undefined,
            referenceKey: remapReferenceKey(reference.referenceKey),
        }));
        if (node.metadata.imageReferenceOrder) node.metadata.imageReferenceOrder = node.metadata.imageReferenceOrder.map(remapReferenceKey);
        if (node.metadata.excludedConnectedImageReferenceKeys) node.metadata.excludedConnectedImageReferenceKeys = node.metadata.excludedConnectedImageReferenceKeys.map(remapReferenceKey);
    });
    const groups = (graph.groups || []).map(group => ({ ...group, id: `group-${nanoid()}`, nodeIds: group.nodeIds.flatMap(id => idMap.has(id) ? [idMap.get(id)!] : []) }));
    return { nodes, connections, groups };
}
