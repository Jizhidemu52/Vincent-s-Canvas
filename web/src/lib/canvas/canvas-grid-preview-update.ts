import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { ViewportTransform } from "@/types/canvas";

export type CanvasGridPreviewUpdate = {
    gridSize: string | null;
    backgroundPosition: string;
};

export function canvasGridPreviewUpdate(
    mode: CanvasBackgroundMode,
    viewport: ViewportTransform,
    previousGridSize: string | null,
): CanvasGridPreviewUpdate | null {
    if (mode === "blank") return null;

    const gridSize = `${(mode === "dots" ? 16 : 48) * viewport.k}px`;
    return {
        gridSize: gridSize === previousGridSize ? null : gridSize,
        backgroundPosition: `${viewport.x % Number.parseFloat(gridSize)}px ${viewport.y % Number.parseFloat(gridSize)}px`,
    };
}
