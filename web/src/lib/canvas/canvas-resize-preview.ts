import type { CanvasNodeData, Position } from "@/types/canvas";

export type CanvasResizeBounds = {
    position: Position;
    width: number;
    height: number;
};

export type CanvasResizePreview = ReadonlyMap<string, CanvasResizeBounds>;

export function createResizePreview(nodeId: string, bounds: CanvasResizeBounds): Map<string, CanvasResizeBounds> {
    return new Map([[nodeId, bounds]]);
}

/**
 * Materializes a node only when it is actively being resized. This keeps the
 * persisted document immutable during a pointer move and avoids cloning the
 * rest of the canvas merely to display a transient size.
 */
export function createResizePreviewNodeResolver(nodeById: ReadonlyMap<string, CanvasNodeData>, preview: CanvasResizePreview) {
    const previewNodes = new Map<string, CanvasNodeData>();
    preview.forEach((bounds, id) => {
        const node = nodeById.get(id);
        if (node) previewNodes.set(id, { ...node, ...bounds });
    });

    return (id: string) => previewNodes.get(id) ?? nodeById.get(id);
}
