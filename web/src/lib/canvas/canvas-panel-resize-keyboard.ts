import { canvasPanelWidths, clampCanvasPanelWidth, type CanvasPanelKind } from "./canvas-panel-width";

export function keyboardCanvasPanelWidth(kind: CanvasPanelKind, width: number, key: string, shiftKey = false) {
    if (key === "Home") return canvasPanelWidths[kind].default;
    if (key === "End") return canvasPanelWidths[kind].max;
    if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
    return clampCanvasPanelWidth(kind, width + (key === "ArrowRight" ? 1 : -1) * (shiftKey ? 40 : 10));
}
