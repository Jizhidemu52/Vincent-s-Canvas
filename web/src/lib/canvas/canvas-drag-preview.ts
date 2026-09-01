import type { CanvasNodeData, Position } from "@/types/canvas";

export type CanvasDragPreview = ReadonlyMap<string, Position>;

export function createDragPreview(initial: ReadonlyArray<{ id: string; x: number; y: number }>, dx: number, dy: number): Map<string, Position> {
    return new Map(initial.map(({ id, x, y }) => [id, { x: x + dx, y: y + dy }]));
}

export function resolvePreviewPosition(node: CanvasNodeData, preview: CanvasDragPreview): Position {
    return preview.get(node.id) ?? node.position;
}
