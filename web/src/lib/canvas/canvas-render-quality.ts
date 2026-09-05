export type CanvasRenderQuality = "full" | "moving" | "overview";

const overviewScale = 0.4;

export function isCanvasOverviewScale(scale: number) {
    return scale <= overviewScale;
}

export function nextCanvasRenderQuality(isInteracting: boolean): CanvasRenderQuality {
    return isInteracting ? "moving" : "full";
}

/**
 * At a far zoom level, detailed media and controls are visually too small to
 * use but still expensive to paint. The overview wins even during a pan so
 * a far-zoom interaction never remounts all detailed node DOM.
 */
export function canvasRenderQualityAtScale(quality: CanvasRenderQuality, scale: number): CanvasRenderQuality {
    if (isCanvasOverviewScale(scale)) return "overview";
    return quality === "moving" ? "moving" : "full";
}
