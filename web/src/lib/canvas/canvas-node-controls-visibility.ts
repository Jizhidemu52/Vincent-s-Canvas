import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

type CanvasNodeControlsVisibility = {
    renderQuality: CanvasRenderQuality;
    hovered: boolean;
    selected: boolean;
    multiSelected?: boolean;
    connecting: boolean;
    kind?: "resize" | "connection";
    isImage?: boolean;
};

/** Selection owns resize controls; image hover alone only previews its outline. */
export function shouldRenderCanvasNodeControls({ renderQuality, hovered, selected, multiSelected = false, connecting, kind = "connection", isImage = false }: CanvasNodeControlsVisibility) {
    if (renderQuality === "moving") return false;
    if (renderQuality === "overview" && selected && multiSelected) {
        // Keep one hovered node's ports (and active connection targets) usable,
        // without adding four resize handles and two ports to every selection.
        if (kind === "resize" || (!hovered && !connecting)) return false;
    }
    if (kind === "resize") return selected;
    const isPassiveOverviewNode = renderQuality === "overview" && !hovered && !selected;
    return !isPassiveOverviewNode && (connecting || (isImage ? selected && hovered : hovered || selected));
}
