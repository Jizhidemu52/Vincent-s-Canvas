import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// Keep recognition independent of the lazily loaded template copy and graph builder.
const templateIds = new Set<unknown>(["development", "print", "range"]);

/** Only a real template source gets the original-image setup UI; attachments are not originals. */
export function isEmptyCanvasDesignTemplateReference(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (node.type !== CanvasNodeType.Image || node.metadata?.content || node.metadata?.storageKey || node.metadata?.generationRecord || node.metadata?.sourceTaskId) return false;
    const targets = new Set(connections.filter(edge => edge.fromNodeId === node.id && edge.kind !== "config-target").map(edge => edge.toNodeId));
    return nodes.some(target => targets.has(target.id) && isEmptyCanvasDesignTemplateReferenceForConfig(node, target));
}

/** A connected upload slot is pending, not a deleted or otherwise unavailable asset. */
export function isEmptyCanvasDesignTemplateReferenceForConfig(node: CanvasNodeData, config: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && !node.metadata?.content && !node.metadata?.storageKey
        && !node.metadata?.generationRecord && !node.metadata?.sourceTaskId
        && config.type === CanvasNodeType.Config && templateIds.has(config.metadata?.promptInput?.fields?.templateId)
        && Boolean(config.metadata?.composerContent?.includes(`@[node:${node.id}]`));
}
