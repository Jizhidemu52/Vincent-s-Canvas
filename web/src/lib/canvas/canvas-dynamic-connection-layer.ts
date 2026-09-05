/** The dynamic link canvas needs one clear after it previously held a drag preview. */
export function shouldClearCanvasDynamicConnectionLayer(previouslyHadContent: boolean, nextHasContent: boolean) {
    return previouslyHadContent && !nextHasContent;
}

/** Avoid a clearRect on every panning frame when this connection canvas is already blank. */
export function shouldDrawCanvasConnectionLayer(previouslyHadContent: boolean, nextHasContent: boolean) {
    return nextHasContent || shouldClearCanvasDynamicConnectionLayer(previouslyHadContent, nextHasContent);
}

export type CanvasConnectionLayerPaintState = {
    hasContent: boolean;
    batches: unknown;
    paintKey: string;
    viewport: { x: number; y: number; k: number };
};

/**
 * A static connection canvas can be asked to draw more than once while a
 * node drag toggles interaction state. If neither its draw batch nor camera
 * changed, painting it again only repeats a full-screen clear and stroke.
 */
export function shouldRedrawCanvasConnectionLayer(previous: CanvasConnectionLayerPaintState | null, next: CanvasConnectionLayerPaintState) {
    if (!shouldDrawCanvasConnectionLayer(previous?.hasContent ?? false, next.hasContent)) return false;
    return !previous || previous.hasContent !== next.hasContent || previous.batches !== next.batches || previous.paintKey !== next.paintKey || previous.viewport.x !== next.viewport.x || previous.viewport.y !== next.viewport.y || previous.viewport.k !== next.viewport.k;
}
