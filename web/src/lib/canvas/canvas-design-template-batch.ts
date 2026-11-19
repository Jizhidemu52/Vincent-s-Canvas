import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup } from "@/types/canvas";

const templateIds = new Set(["development", "print", "range"]);

export function canvasDesignTemplateBatches(nodes: CanvasNodeData[], groups: CanvasNodeGroup[], connections: CanvasConnection[]) {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const sequenceIds = new Set(connections.filter(edge => edge.kind === "config-sequence").flatMap(edge => [edge.fromNodeId, edge.toNodeId]));
    return groups.flatMap(group => {
        if (group.imageSequence || group.nodeIds.some(id => sequenceIds.has(id))) return [];
        const templates = new Map<string, CanvasNodeData[]>();
        for (const id of group.nodeIds) {
            const node = nodeById.get(id), templateId = node?.metadata?.promptInput?.fields?.templateId;
            if (node?.type !== CanvasNodeType.Config || typeof templateId !== "string" || !templateIds.has(templateId)) continue;
            const configs = templates.get(templateId) || [];
            configs.push(node); templates.set(templateId, configs);
        }
        return [...templates].filter(([, configs]) => configs.length > 1).map(([templateId, configs]) => ({ id: `template:${group.id}:${templateId}`, nodes: configs }));
    });
}

export function canvasDesignTemplateBatch(nodeId: string, nodes: CanvasNodeData[], groups: CanvasNodeGroup[], connections: CanvasConnection[]) {
    return canvasDesignTemplateBatches(nodes, groups, connections).find(batch => batch.nodes.some(node => node.id === nodeId)) || null;
}
