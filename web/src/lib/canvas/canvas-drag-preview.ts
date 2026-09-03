import type { CanvasNodeData, Position } from "@/types/canvas";
import type { CanvasResizePreview } from "@/lib/canvas/canvas-resize-preview";

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
export function createPreviewNodeResolver(nodeById: ReadonlyMap<string, CanvasNodeData>, preview: CanvasDragPreview, resizePreview: CanvasResizePreview = new Map()) {
    const previewNodes = new Map<string, CanvasNodeData>();
    resizePreview.forEach((bounds, id) => {
        const node = nodeById.get(id);
        if (node) previewNodes.set(id, { ...node, ...bounds });
    });
    preview.forEach((position, id) => {
        const node = previewNodes.get(id) ?? nodeById.get(id);
        if (node) previewNodes.set(id, { ...node, position });
    });

    return (id: string) => previewNodes.get(id) ?? nodeById.get(id);
}

/**
 * Keeps connection geometry in sync with rAF drag updates without requiring a
 * React render for every pointer frame. It only rebuilds preview node copies
 * after one of the preview maps has actually changed.
 */
export function createLivePreviewNodeResolver(
    nodeById: ReadonlyMap<string, CanvasNodeData>,
    dragPreviewRef: { current: CanvasDragPreview },
    resizePreviewRef: { current: CanvasResizePreview },
) {
    let previousDragPreview: CanvasDragPreview | undefined;
    let previousResizePreview: CanvasResizePreview | undefined;
    let resolve = createPreviewNodeResolver(nodeById, dragPreviewRef.current, resizePreviewRef.current);

    return (id: string) => {
        if (previousDragPreview !== dragPreviewRef.current || previousResizePreview !== resizePreviewRef.current) {
            previousDragPreview = dragPreviewRef.current;
            previousResizePreview = resizePreviewRef.current;
            resolve = createPreviewNodeResolver(nodeById, previousDragPreview, previousResizePreview);
        }
        return resolve(id);
    };
}
