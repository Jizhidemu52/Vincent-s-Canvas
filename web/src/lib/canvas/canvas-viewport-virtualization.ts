import { isCanvasOverviewScale } from "@/lib/canvas/canvas-render-quality";
import type { ViewportTransform } from "@/types/canvas";

const DETAIL_ZOOM_REFRESH_RATIO = 0.16;
const OVERVIEW_ZOOM_REFRESH_RATIO = 0.3;

export function canvasVirtualizationZoomRefreshRatio(previous: ViewportTransform, next: ViewportTransform) {
    return isCanvasOverviewScale(previous.k) && isCanvasOverviewScale(next.k) ? OVERVIEW_ZOOM_REFRESH_RATIO : DETAIL_ZOOM_REFRESH_RATIO;
}

/**
 * Virtualized nodes keep one viewport of overscan mounted. Publish a live
 * viewport only after crossing half that safety band, avoiding empty space
 * during long pans without scheduling React work for every input frame.
 */
export function shouldRefreshCanvasVirtualization(previous: ViewportTransform, next: ViewportTransform, refreshDistance: number) {
    const moved = Math.hypot(next.x - previous.x, next.y - previous.y) >= refreshDistance;
    const overviewChanged = isCanvasOverviewScale(previous.k) !== isCanvasOverviewScale(next.k);
    const zoomDelta = Math.abs(next.k - previous.k) / Math.max(previous.k, 0.0001);
    const zoomed = overviewChanged || zoomDelta + Number.EPSILON >= canvasVirtualizationZoomRefreshRatio(previous, next);
    return moved || zoomed;
}
