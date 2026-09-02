import type { CanvasNodeData, Position } from "@/types/canvas";

export type CanvasDragPreview = ReadonlyMap<string, Position>;

export function createDragPreview(initial: ReadonlyArray<{ id: string; x: number; y: number }>, dx: number, dy: number): Map<string, Position> {
    return new Map(initial.map(({ id, x, y }) => [id, { x: x + dx, y: y + dy }]));
}

export function resolvePreviewPosition(node: CanvasNodeData, preview: CanvasDragPreview): Position {
    return preview.get(node.id) ?? node.position;
}

/**
 * Keeps the persisted node index intact during an rAF drag preview. Only the
 * actively dragged nodes receive short-lived position copies, so large canvas
 * drags do not clone every node merely to render a handful of moving nodes.
 */
export function createPreviewNodeResolver(nodeById: ReadonlyMap<string, CanvasNodeData>, preview: CanvasDragPreview) {
    const previewNodes = new Map<string, CanvasNodeData>();
    preview.forEach((position, id) => {
        const node = nodeById.get(id);
        if (node) previewNodes.set(id, { ...node, position });
    });

    return (id: string) => previewNodes.get(id) ?? nodeById.get(id);
}
