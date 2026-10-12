import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

/**
 * The spatial index intentionally keeps an overscan band mounted so a fast
 * pan never exposes empty space. Let supporting browsers skip the inner paint
 * work for nodes that remain outside the actual viewport.
 */
export const canvasNodeRenderingStyle = {
    contain: "layout style",
    contentVisibility: "auto",
} as const;

/** A bulk selection is still an overview, not a request to open every editor/media player. */
export function shouldUseCanvasNodeOverview({ renderQuality, selected, multiSelected, focused, connectionTarget, showPanel, editing, hovered }: {
    renderQuality: CanvasRenderQuality;
    selected: boolean;
    multiSelected: boolean;
    focused: boolean;
    connectionTarget: boolean;
    showPanel: boolean;
    editing: boolean;
    hovered: boolean;
}) {
    if (renderQuality !== "overview" || focused || connectionTarget || showPanel || editing) return false;
    if (selected && multiSelected) return true;
    return !selected && !hovered;
}
