import type { MinimapNodeRect } from "@/lib/canvas/canvas-minimap-layout";

export function drawMinimapNodeRects(context: CanvasRenderingContext2D, rects: MinimapNodeRect[]) {
    context.globalAlpha = 0.8;
    rects.forEach((rect) => {
        context.fillStyle = rect.color;
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
    });
    context.globalAlpha = 1;
}
