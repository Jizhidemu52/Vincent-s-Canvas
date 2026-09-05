import { canvasViewportTransform } from "@/lib/canvas/canvas-viewport-interaction";
import type { ViewportTransform } from "@/types/canvas";

/** Keeps compositor promotion scoped to a live canvas interaction. */
export function canvasViewportContentStyle(viewport: ViewportTransform, isInteracting: boolean) {
    return {
        transform: canvasViewportTransform(viewport),
        willChange: isInteracting ? "transform" : "auto",
    } as const;
}
