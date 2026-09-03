import type { Position, ViewportTransform } from "@/types/canvas";

export function minimapViewportAtWorldPoint(world: Position, viewportSize: { width: number; height: number }, scale: number): ViewportTransform {
    return {
        x: viewportSize.width / 2 - world.x * scale,
        y: viewportSize.height / 2 - world.y * scale,
        k: scale,
    };
}
