import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** Keep pointer interaction responsive; a final answer is always committed separately. */
export function shouldPublishCanvasTextStream(renderQuality: CanvasRenderQuality, isDragging: boolean) {
    return renderQuality === "full" && !isDragging;
}

/** A text node can expose useful partial output instead of replacing it with a spinner. */
export function shouldShowCanvasTextStream(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Text && node.metadata?.status === "loading" && Boolean(node.metadata.content);
}
