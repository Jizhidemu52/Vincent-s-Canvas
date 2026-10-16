import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * The spatial index intentionally keeps an overscan band mounted so a fast
 * pan never exposes empty space. Let supporting browsers skip the inner paint
 * work for nodes that remain outside the actual viewport.
 */
export const canvasNodeRenderingStyle = {
    contain: "layout style",
    contentVisibility: "auto",
} as const;

/** Image previews stay identifiable at low zoom, including lazily restored local files. */
export function canvasNodeHasImagePreview(node: CanvasNodeData) {
    return node.type === "image" && Boolean(node.metadata?.content || node.metadata?.storageKey);
}

/** Keep bulk editors lightweight without replacing image previews with empty summaries. */
export function shouldUseCanvasNodeOverview({ renderQuality, selected, multiSelected, focused, connectionTarget, showPanel, editing, hovered, hasImagePreview = false }: {
    renderQuality: CanvasRenderQuality;
    selected: boolean;
    multiSelected: boolean;
    focused: boolean;
    connectionTarget: boolean;
    showPanel: boolean;
    editing: boolean;
    hovered: boolean;
    hasImagePreview?: boolean;
}) {
    if (hasImagePreview || renderQuality !== "overview" || focused || connectionTarget || showPanel || editing) return false;
    return selected ? multiSelected : !hovered;
}
