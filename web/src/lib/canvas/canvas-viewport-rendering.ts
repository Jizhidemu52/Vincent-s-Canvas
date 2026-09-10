import { canvasViewportTransform } from "@/lib/canvas/canvas-viewport-interaction";
import type { ViewportTransform } from "@/types/canvas";

/** Keeps compositor promotion scoped to a live canvas interaction. */
export function canvasViewportContentStyle(viewport: ViewportTransform, isInteracting: boolean) {
    return {
        transform: canvasViewportTransform(viewport),
        "--canvas-node-ui-scale": 1 / Math.max(viewport.k, 0.0001),
        willChange: isInteracting ? "transform" : "auto",
    } as const;
}
