import type { ViewportTransform } from "@/types/canvas";

export function zoomViewportAtPoint(viewport: ViewportTransform, point: { x: number; y: number }, scale: number): ViewportTransform {
    const worldX = (point.x - viewport.x) / viewport.k;
    const worldY = (point.y - viewport.y) / viewport.k;
    return {
        x: point.x - worldX * scale,
        y: point.y - worldY * scale,
        k: scale,
    };
}

export function zoomViewportAtCanvasCenter(viewport: ViewportTransform, canvasSize: { width: number; height: number }, scale: number): ViewportTransform {
    return zoomViewportAtPoint(viewport, { x: canvasSize.width / 2, y: canvasSize.height / 2 }, scale);
}

export function canvasViewportTransform(viewport: ViewportTransform) {
    return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`;
}
