import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

/** Hover-only UI has no value while the canvas is moving and can trigger extra node renders. */
export function canvasNodeEffectiveHover(hovered: boolean, renderQuality: CanvasRenderQuality) {
    return hovered && renderQuality !== "moving";
}
