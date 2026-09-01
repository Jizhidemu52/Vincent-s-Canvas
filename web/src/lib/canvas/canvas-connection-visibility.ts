import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData } from "@/types/canvas";

export function connectionIntersectsCanvasBounds(from: CanvasNodeData, to: CanvasNodeData, bounds: CanvasBounds): boolean {
    const startX = from.position.x + from.width;
    const startY = from.position.y + from.height / 2;
    const endX = to.position.x;
    const endY = to.position.y + to.height / 2;
    const curvature = Math.max(Math.abs(endX - startX) * 0.5, 50);
    const curveBounds = {
        minX: Math.min(startX, startX + curvature, endX - curvature, endX),
        minY: Math.min(startY, endY),
        maxX: Math.max(startX, startX + curvature, endX - curvature, endX),
        maxY: Math.max(startY, endY),
    };

    return curveBounds.maxX > bounds.minX && curveBounds.minX < bounds.maxX && curveBounds.maxY > bounds.minY && curveBounds.minY < bounds.maxY;
}
