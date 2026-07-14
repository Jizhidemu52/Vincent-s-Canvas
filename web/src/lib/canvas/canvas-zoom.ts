export const MIN_CANVAS_ZOOM = 0.05;
export const MAX_CANVAS_ZOOM = 100;

export function clampCanvasZoom(scale: number) {
    return Math.min(Math.max(scale, MIN_CANVAS_ZOOM), MAX_CANVAS_ZOOM);
}
