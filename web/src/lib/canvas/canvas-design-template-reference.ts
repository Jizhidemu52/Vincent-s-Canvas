import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// Keep recognition independent of the lazily loaded template copy and graph builder.
const templateIds = new Set<unknown>(["development", "print", "range"]);

/** Only a real template source gets the original-image setup UI; attachments are not originals. */
export function isEmptyCanvasDesignTemplateReference(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (node.type !== CanvasNodeType.Image || node.metadata?.content || node.metadata?.storageKey || node.metadata?.generationRecord || node.metadata?.sourceTaskId) return false;
    const targets = new Set(connections.filter(edge => edge.fromNodeId === node.id && edge.kind !== "config-target").map(edge => edge.toNodeId));
    return nodes.some(target => targets.has(target.id) && target.type === CanvasNodeType.Config
        && templateIds.has(target.metadata?.promptInput?.fields?.templateId)
        && target.metadata?.composerContent?.includes(`@[node:${node.id}]`));
}
