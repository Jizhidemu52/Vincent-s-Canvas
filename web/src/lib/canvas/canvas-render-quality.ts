export type CanvasRenderQuality = "full" | "moving";

export function nextCanvasRenderQuality(isInteracting: boolean): CanvasRenderQuality {
    return isInteracting ? "moving" : "full";
}
