export type CanvasConnectionCanvasSize = {
    cssWidth: number;
    cssHeight: number;
    pixelRatio: number;
    width: number;
    height: number;
};

const MAX_CANVAS_PIXEL_RATIO = 2;

export function canvasConnectionCanvasSize(cssWidth: number, cssHeight: number, pixelRatio: number, maxPixelRatio = MAX_CANVAS_PIXEL_RATIO): CanvasConnectionCanvasSize | null {
    if (cssWidth <= 0 || cssHeight <= 0) return null;
    // A 3x/4x backing buffer turns every full-screen clear and path stroke
    // into 2.25x/4x more pixels. Two device pixels are visually sufficient
    // for the thin canvas links while keeping high-density displays smooth.
    const safeMaxPixelRatio = Number.isFinite(maxPixelRatio) && maxPixelRatio > 0 ? maxPixelRatio : MAX_CANVAS_PIXEL_RATIO;
    const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(pixelRatio, safeMaxPixelRatio) : 1;
    return {
        cssWidth,
        cssHeight,
        pixelRatio: safePixelRatio,
        width: Math.round(cssWidth * safePixelRatio),
        height: Math.round(cssHeight * safePixelRatio),
    };
}
