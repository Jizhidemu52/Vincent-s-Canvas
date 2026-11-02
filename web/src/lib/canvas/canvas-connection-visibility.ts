import type { CanvasBounds } from "@/lib/canvas/canvas-spatial-index";
import type { CanvasNodeData } from "@/types/canvas";
import { createConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";

export function boundsForCanvasConnection(from: CanvasNodeData, to: CanvasNodeData): CanvasBounds {
    return createConnectionGeometry(from, to).bounds;
}

export function connectionIntersectsCanvasBounds(from: CanvasNodeData, to: CanvasNodeData, bounds: CanvasBounds): boolean {
    const curveBounds = boundsForCanvasConnection(from, to);
    return curveBounds.maxX > bounds.minX && curveBounds.minX < bounds.maxX && curveBounds.maxY > bounds.minY && curveBounds.minY < bounds.maxY;
}
