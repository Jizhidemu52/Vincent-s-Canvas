import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

export function canvasMediaPlaybackProps(renderQuality: CanvasRenderQuality) {
    const isInteractive = renderQuality === "full";
    const preload: "metadata" | "none" = isInteractive ? "metadata" : "none";
    return { controls: isInteractive, preload };
}
