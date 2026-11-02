import { selectCanvasSpatialIndexNodes, type CanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData, ConnectionHandle, Position } from "@/types/canvas";

export const CANVAS_CONNECTION_HANDLE_HIT_RADIUS = 40;
export const CANVAS_CONNECTION_NODE_HIT_PADDING = 32;

export type CanvasConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
    invalidNodeId?: string;
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
    let bestDistance = Number.POSITIVE_INFINITY;
    let invalidNodeId: string | undefined;
    let invalidDistance = Number.POSITIVE_INFINITY;

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
            if (node.id === current.nodeId) return;
            const distance = dx * dx + dy * dy;
            if (!canConnect(node)) {
                if (distance < invalidDistance) { invalidNodeId = node.id; invalidDistance = distance; }
                return;
            }

            const priority = hitsHandle ? 0 : hitsInside ? 1 : 2;
            if (priority < bestPriority || (priority === bestPriority && distance < bestDistance)) {
                bestNodeId = node.id;
                bestPriority = priority;
                bestDistance = distance;
            }
        });

    return { nodeId: bestNodeId, isNearNode, ...(!bestNodeId && invalidNodeId ? { invalidNodeId } : {}) };
}
