import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

type CanvasNodeControlsVisibility = {
    renderQuality: CanvasRenderQuality;
    hovered: boolean;
    selected: boolean;
    connecting: boolean;
    kind?: "resize" | "connection";
    isImage?: boolean;
};

/** Selection owns resize controls; image hover alone only previews its outline. */
export function shouldRenderCanvasNodeControls({ renderQuality, hovered, selected, connecting, kind = "connection", isImage = false }: CanvasNodeControlsVisibility) {
    if (renderQuality === "moving") return false;
    if (kind === "resize") return selected;
    const isPassiveOverviewNode = renderQuality === "overview" && !hovered && !selected;
    return !isPassiveOverviewNode && (connecting || (isImage ? selected && hovered : hovered || selected));
}
