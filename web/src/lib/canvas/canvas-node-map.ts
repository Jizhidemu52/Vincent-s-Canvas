import type { CanvasNodeData } from "@/types/canvas";

export type CanvasNodeMap = Map<string, CanvasNodeData>;

export function createCanvasNodeMap(nodes: CanvasNodeData[]): CanvasNodeMap {
    return new Map(nodes.map((node) => [node.id, node]));
}

/**
 * Content-only updates are common while text streams or generation status
 * changes. Keep dependent connection selectors stable until an endpoint's
 * geometry or ordering actually changes.
 */
export function refreshCanvasNodeMap(previous: CanvasNodeMap, nodes: CanvasNodeData[]): CanvasNodeMap {
    if (previous.size !== nodes.length) return createCanvasNodeMap(nodes);

    // Streaming a text node or updating a generation status used to scan every
    // node once to validate geometry, then a second time to replace the one
    // changed record. Collect the small changed subset while validating so the
    // common content-only path remains a single canvas-wide pass.
    const replacements: CanvasNodeData[] = [];
    let previousOrder = 0;
    for (const previousNode of previous.values()) {
        const next = nodes[previousOrder];
        if (!next || next.id !== previousNode.id) return createCanvasNodeMap(nodes);
        if (
            next.type !== previousNode.type ||
            next.position.x !== previousNode.position.x ||
            next.position.y !== previousNode.position.y ||
            next.width !== previousNode.width ||
            next.height !== previousNode.height ||
            resourceIndexKey(next) !== resourceIndexKey(previousNode) ||
            batchIndexKey(next) !== batchIndexKey(previousNode)
        )
            return createCanvasNodeMap(nodes);
        if (next !== previousNode) replacements.push(next);
        previousOrder += 1;
    }

    replacements.forEach((node) => previous.set(node.id, node));
    return previous;
}

function resourceIndexKey(node: CanvasNodeData) {
    if (node.type === "image") return node.metadata?.content ? "image" : "";
    if (node.type === "video") return node.metadata?.content ? "video" : "";
    if (node.type === "audio") return node.metadata?.content ? "audio" : "";
    if (node.type === "text") return node.metadata?.content || node.metadata?.prompt ? "text" : "";
    return "";
}

function batchIndexKey(node: CanvasNodeData) {
    const metadata = node.metadata;
    // A batch root's expanded state controls whether all of its children are
    // mounted. Treat it as index geometry: keeping the live map identity on
    // this change leaves the cached root map pointing at the old visibility
    // state, so an expand/collapse can look delayed on a large canvas.
    const expanded = metadata?.isBatchRoot ? (metadata.imageBatchExpanded ? "expanded" : "collapsed") : "";
    return `${metadata?.isBatchRoot ? "root" : ""}:${metadata?.batchRootId || ""}:${metadata?.batchChildIds?.join("|") || ""}:${expanded}`;
}
