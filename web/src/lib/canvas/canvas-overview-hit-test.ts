import type { CanvasNodeData, Position } from "@/types/canvas";

/**
 * Low-zoom nodes are painted into one canvas, so their click target is
 * resolved lazily from the already-visible node list instead of keeping one
 * DOM event surface per node.
 */
export function findCanvasOverviewNodeHit(nodes: readonly CanvasNodeData[], world: Position) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height) return node;
    }
    return null;
}
