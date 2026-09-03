import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

export function canvasMediaPlaybackProps(renderQuality: CanvasRenderQuality) {
    return { controls: renderQuality === "full", preload: "metadata" as const };
}
