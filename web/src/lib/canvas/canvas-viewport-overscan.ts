import type { ViewportTransform } from "@/types/canvas";

const MINIMUM_OVERSCAN = 280;

export function canvasViewportOverscan(viewport: ViewportTransform, width: number, height: number): number {
    return Math.max(MINIMUM_OVERSCAN, Math.max(width, height) / Math.max(viewport.k, 0.0001));
}
