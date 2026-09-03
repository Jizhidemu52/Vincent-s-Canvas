import { selectCanvasSpatialIndexNodes, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export const CANVAS_CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CANVAS_CONNECTION_NODE_HIT_PADDING = 32;

export type CanvasConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

export function findCanvasConnectionDropTarget({
    index,
    world,
    current,
    scale,
    canConnect,
    isHiddenNode = () => false,
}: {
    index: CanvasSpatialIndex;
    world: Position;
    current: ConnectionHandle;
    scale: number;
    canConnect: (node: CanvasNodeData) => boolean;
    isHiddenNode?: (node: CanvasNodeData) => boolean;
}): CanvasConnectionDropTarget {
    const safeScale = Math.max(scale, 0.05);
    const padding = CANVAS_CONNECTION_NODE_HIT_PADDING / safeScale;
    const handleRadius = CANVAS_CONNECTION_HANDLE_HIT_RADIUS / safeScale;
    const queryRadius = Math.max(padding, handleRadius);
    let isNearNode = false;
    let bestNodeId: string | null = null;
    let bestPriority = Number.POSITIVE_INFINITY;

    selectCanvasSpatialIndexNodes(
        index,
        { minX: world.x - queryRadius, minY: world.y - queryRadius, maxX: world.x + queryRadius, maxY: world.y + queryRadius },
        (node) => !isHiddenNode(node),
    )
        .reverse()
        .forEach((node) => {
            const anchor = current.handleType === "source" ? { x: node.position.x, y: node.position.y + node.height / 2 } : { x: node.position.x + node.width, y: node.position.y + node.height / 2 };
            const dx = world.x - anchor.x;
            const dy = world.y - anchor.y;
            const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
            const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
            const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

            if (!hitsHandle && !hitsInside && !hitsExpanded) return;
            isNearNode = true;
            if (node.id === current.nodeId || !canConnect(node)) return;

            const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
            if (priority < bestPriority) {
                bestNodeId = node.id;
                bestPriority = priority;
            }
        });

    return { nodeId: bestNodeId, isNearNode };
}
