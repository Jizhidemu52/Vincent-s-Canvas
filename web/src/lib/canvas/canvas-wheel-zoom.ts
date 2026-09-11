import type { ViewportTransform } from "@/types/canvas";

const MAX_WHEEL_DELTA = 240;
export const CANVAS_WHEEL_EASE_MS = 100;

/** Approximately 26% per 100px; normalize line/page wheels before bounding noise. */
export function canvasWheelZoomFactor(deltaY: number, deltaMode = 0, pageHeight = 800) {
    if (!Number.isFinite(deltaY)) return 1;
    const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
    const boundedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, -pixels));
    return Math.pow(2, boundedDelta / 300);
}

/** Accumulate same-direction input, but discard pending motion on reversal. */
export function canvasWheelTargetScale(current: number, pending: number | undefined, factor: number) {
    const base = pending !== undefined && (pending - current) * (factor - 1) > 0 ? pending : current;
    return base * factor;
}

/** Interpolating translation and scale together keeps the zoom anchor stationary. */
export function easeCanvasWheelViewport(from: ViewportTransform, to: ViewportTransform, elapsedMs: number): ViewportTransform {
    const progress = Math.max(0, Math.min(1, elapsedMs / CANVAS_WHEEL_EASE_MS));
    if (progress === 1) return to;
    const amount = 1 - Math.pow(1 - progress, 3);
    return {
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount,
        k: from.k + (to.k - from.k) * amount,
    };
}
