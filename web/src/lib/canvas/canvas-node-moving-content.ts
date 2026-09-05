import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { CanvasNodeType } from "@/types/canvas";

type CanvasNodeMovingContent = {
    type: CanvasNodeType;
    renderQuality: CanvasRenderQuality;
    active: boolean;
    hovered: boolean;
    showPanel: boolean;
};

/**
 * A config node contains menus and controlled inputs. Those controls cannot be
 * used during a viewport gesture, so render a stable visual summary instead.
 */
export function shouldUseCanvasNodeMovingPlaceholder({ type, renderQuality, active, hovered, showPanel }: CanvasNodeMovingContent) {
    return type === CanvasNodeType.Config && renderQuality === "moving" && !active && !hovered && !showPanel;
}
