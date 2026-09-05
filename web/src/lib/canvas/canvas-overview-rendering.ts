import type { CanvasNodeData } from "@/types/canvas";

/**
 * Selected overview nodes are rendered as their full DOM counterpart, so the
 * lightweight overview canvas must leave those rectangles out.
 */
export function filterCanvasOverviewRenderNodes(nodes: CanvasNodeData[], excludedNodeIds: ReadonlySet<string>): CanvasNodeData[] {
    if (!excludedNodeIds.size) return nodes;
    return nodes.filter((node) => !excludedNodeIds.has(node.id));
}
