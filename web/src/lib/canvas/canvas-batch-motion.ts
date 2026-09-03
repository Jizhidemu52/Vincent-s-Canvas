import type { CanvasNodeData } from "@/types/canvas";

export type CanvasBatchMotion = { x: number; y: number; index: number };

export function createCanvasBatchMotionById(nodes: CanvasNodeData[], nodeById: ReadonlyMap<string, CanvasNodeData>) {
    const childIndexByRootAndId = new Map<string, number>();
    nodes.forEach((node) => {
        if (!node.metadata?.isBatchRoot) return;
        node.metadata.batchChildIds?.forEach((childId, index) => childIndexByRootAndId.set(`${node.id}:${childId}`, index));
    });

    const motionById = new Map<string, CanvasBatchMotion>();
    nodes.forEach((node) => {
        const rootId = node.metadata?.batchRootId;
        if (!rootId) return;
        const root = nodeById.get(rootId);
        const index = root?.metadata?.batchChildIds ? childIndexByRootAndId.get(`${rootId}:${node.id}`) ?? -1 : 0;
        const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
        const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
        motionById.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
    });
    return motionById;
}
