import { boundsForViewport } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const OVERVIEW_EDGE_PADDING_PX = 24;

export function canvasOverviewViewportBounds(viewport: ViewportTransform, canvasSize: { width: number; height: number }) {
    return boundsForViewport(viewport, canvasSize.width, canvasSize.height, OVERVIEW_EDGE_PADDING_PX / Math.max(viewport.k, 0.0001));
}

/**
 * Keeps a small screen-space margin while excluding the larger data overscan
 * that is retained for smooth panning. The input viewport can be a live
 * preview value, so each canvas redraw only traces nodes near the screen.
 */
export function nodeIntersectsCanvasOverviewViewport(
    node: CanvasNodeData,
    viewport: ViewportTransform,
    canvasSize: { width: number; height: number },
): boolean {
    const { minX, minY, maxX, maxY } = canvasOverviewViewportBounds(viewport, canvasSize);

    return node.position.x + node.width > minX && node.position.x < maxX && node.position.y + node.height > minY && node.position.y < maxY;
}
