/**
 * Image canvas manipulation is only needed after the user opens an image tool.
 * Keep the browser-canvas implementation out of the canvas startup bundle.
 */
export function loadCanvasImageTools() {
    return import("@/lib/canvas/canvas-image-data");
}
