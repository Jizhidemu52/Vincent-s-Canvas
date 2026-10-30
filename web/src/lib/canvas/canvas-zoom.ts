export const MIN_CANVAS_ZOOM = 0.05;
export const MAX_CANVAS_ZOOM = 16;

export function clampCanvasZoom(scale: number) {
    return Math.min(Math.max(scale, MIN_CANVAS_ZOOM), MAX_CANVAS_ZOOM);
}

export function canvasZoomSliderValue(scale: number) {
    return Math.log(clampCanvasZoom(scale) / MIN_CANVAS_ZOOM) / Math.log(MAX_CANVAS_ZOOM / MIN_CANVAS_ZOOM) * 1000;
}

export function canvasZoomFromSlider(value: number) {
    return clampCanvasZoom(MIN_CANVAS_ZOOM * (MAX_CANVAS_ZOOM / MIN_CANVAS_ZOOM) ** (value / 1000));
}
