import type { CanvasNodeData, Position } from "@/types/canvas";

export type CanvasResizeHandle = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "left" | "right" | "top" | "bottom";

/** One geometric constraint for both preview and commit, including tiny photos. */
export function resolveCanvasNodeResize({ position, width: initialWidth, height: initialHeight, delta, handle, keepRatio, centered = false, minWidth = 48, minHeight = 48 }: {
    position: Position; width: number; height: number; delta: Position; handle: CanvasResizeHandle; keepRatio: boolean; centered?: boolean; minWidth?: number; minHeight?: number;
}) {
    const horizontal = handle.includes("left") || handle.includes("right");
    const vertical = handle.includes("top") || handle.includes("bottom");
    const left = handle.includes("left"), top = handle.includes("top");
    const multiplier = centered ? 2 : 1;
    const dx = horizontal ? delta.x * (left ? -1 : 1) * multiplier : 0;
    const dy = vertical ? delta.y * (top ? -1 : 1) * multiplier : 0;
    let width = Math.max(minWidth, initialWidth + dx), height = Math.max(minHeight, initialHeight + dy);
    if (keepRatio) {
        const rawFactor = horizontal && vertical
            ? 1 + (dx * initialWidth + dy * initialHeight) / (initialWidth ** 2 + initialHeight ** 2)
            : horizontal ? 1 + dx / initialWidth : 1 + dy / initialHeight;
        const factor = Math.max(minWidth / initialWidth, minHeight / initialHeight, rawFactor);
        width = initialWidth * factor;
        height = initialHeight * factor;
    } else {
        if (!horizontal) width = initialWidth;
        if (!vertical) height = initialHeight;
    }
    return { width, height, position: {
        x: centered ? position.x + (initialWidth - width) / 2 : left ? position.x + initialWidth - width : position.x,
        y: centered ? position.y + (initialHeight - height) / 2 : top ? position.y + initialHeight - height : position.y,
    } };
}

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
