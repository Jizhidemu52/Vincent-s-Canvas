export type CanvasConnectionCanvasSize = {
    cssWidth: number;
    cssHeight: number;
    pixelRatio: number;
    width: number;
    height: number;
};

export function canvasConnectionCanvasSize(cssWidth: number, cssHeight: number, pixelRatio: number): CanvasConnectionCanvasSize | null {
    if (cssWidth <= 0 || cssHeight <= 0) return null;
    return {
        cssWidth,
        cssHeight,
        pixelRatio,
        width: Math.round(cssWidth * pixelRatio),
        height: Math.round(cssHeight * pixelRatio),
    };
}
