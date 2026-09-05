import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

type CanvasNodeControlsVisibility = {
    renderQuality: CanvasRenderQuality;
    hovered: boolean;
    selected: boolean;
    connecting: boolean;
};

/** Keep inactive node hit targets out of the live canvas DOM. */
export function shouldRenderCanvasNodeControls({ renderQuality, hovered, selected, connecting }: CanvasNodeControlsVisibility) {
    if (renderQuality === "moving") return false;
    const isPassiveOverviewNode = renderQuality === "overview" && !hovered && !selected;
    return !isPassiveOverviewNode && (hovered || selected || connecting);
}
