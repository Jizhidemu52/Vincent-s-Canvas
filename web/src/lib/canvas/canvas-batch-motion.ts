import type { CanvasNodeData } from "@/types/canvas";

export type CanvasBatchMotion = { x: number; y: number; index: number };

export type CanvasBatchIndexes = {
    rootsById: Map<string, CanvasNodeData>;
    motionById: Map<string, CanvasBatchMotion>;
    childCountByRootId: Map<string, number>;
};

export type CanvasBatchRenderIndex = Pick<CanvasBatchIndexes, "rootsById" | "childCountByRootId"> & {
    getMotion: (node: CanvasNodeData) => CanvasBatchMotion | undefined;
};

/**
 * The canvas only needs stack offsets for its mounted (virtualized) children.
 * Build root metadata once, then cache a child's offset on first render instead
 * of walking every batch child whenever unrelated node content changes.
 */
export function createCanvasBatchRenderIndex(nodes: Iterable<CanvasNodeData>): CanvasBatchRenderIndex {
    const rootsById = new Map<string, CanvasNodeData>();
    const childCountByRootId = new Map<string, number>();
    const childIndexByRootAndId = new Map<string, number>();
    const motionById = new Map<string, CanvasBatchMotion>();

    for (const node of nodes) {
        if (!node.metadata?.isBatchRoot) continue;
        rootsById.set(node.id, node);
        childCountByRootId.set(node.id, node.metadata.batchChildIds?.length || 0);
        node.metadata.batchChildIds?.forEach((childId, index) => childIndexByRootAndId.set(`${node.id}:${childId}`, index));
    }

    return {
        rootsById,
        childCountByRootId,
        getMotion(node) {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return undefined;
            const cached = motionById.get(node.id);
            if (cached) return cached;
            const root = rootsById.get(rootId);
            const index = root?.metadata?.batchChildIds ? childIndexByRootAndId.get(`${rootId}:${node.id}`) ?? -1 : 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            const motion = { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) };
            motionById.set(node.id, motion);
            return motion;
        },
    };
}

/**
 * Batch root visibility and child stack motion are both derived from the same
 * metadata. Build them together so routine node content updates do not walk a
 * large canvas three separate times.
 */
export function createCanvasBatchIndexes(nodes: CanvasNodeData[], _nodeById: ReadonlyMap<string, CanvasNodeData>): CanvasBatchIndexes {
    const renderIndex = createCanvasBatchRenderIndex(nodes);
    const motionById = new Map<string, CanvasBatchMotion>();
    nodes.forEach((node) => {
        const motion = renderIndex.getMotion(node);
        if (motion) motionById.set(node.id, motion);
    });
    return { rootsById: renderIndex.rootsById, motionById, childCountByRootId: renderIndex.childCountByRootId };
}

export function createCanvasBatchMotionById(nodes: CanvasNodeData[], nodeById: ReadonlyMap<string, CanvasNodeData>) {
    return createCanvasBatchIndexes(nodes, nodeById).motionById;
}
