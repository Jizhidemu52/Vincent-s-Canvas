import type { CanvasNodeData, Position } from "@/types/canvas";

export type CanvasNodeResizePointer = {
    startX: number;
    startY: number;
    clientX: number;
    clientY: number;
    scale: number;
};

/**
 * Converts a pointer movement in screen pixels to canvas-world coordinates.
 * The scale is read at resize time so viewport-only updates do not need to
 * invalidate every rendered node.
 */
export function canvasNodeResizePointerDelta({ startX, startY, clientX, clientY, scale }: CanvasNodeResizePointer) {
    const safeScale = Math.max(scale, 0.0001);
    return {
        x: (clientX - startX) / safeScale,
        y: (clientY - startY) / safeScale,
    };
}

/**
 * A resize event can fire for every pointer frame. The project already keeps a
 * live node-id map for the canvas, so resolve the original position from that
 * map instead of scanning every node during the gesture.
 */
export function canvasNodeResizeStartPosition(nodeById: ReadonlyMap<string, CanvasNodeData> | null | undefined, nodeId: string, explicitPosition?: Position): Position {
    return explicitPosition || nodeById?.get(nodeId)?.position || { x: 0, y: 0 };
}
