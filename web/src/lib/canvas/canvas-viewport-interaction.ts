import type { ViewportTransform } from "@/types/canvas";

export function zoomViewportAtPoint(viewport: ViewportTransform, point: { x: number; y: number }, scale: number): ViewportTransform {
    const worldX = (point.x - viewport.x) / viewport.k;
    const worldY = (point.y - viewport.y) / viewport.k;
    return {
        x: point.x - worldX * scale,
        y: point.y - worldY * scale,
        k: scale,
    };
}

export function zoomViewportAtCanvasCenter(viewport: ViewportTransform, canvasSize: { width: number; height: number }, scale: number): ViewportTransform {
    return zoomViewportAtPoint(viewport, { x: canvasSize.width / 2, y: canvasSize.height / 2 }, scale);
}

export function canvasViewportTransform(viewport: ViewportTransform) {
    return `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`;
}

/** React may publish an earlier virtualized viewport after a newer live frame. */
export function createCanvasViewportPreview(initial: ViewportTransform) {
    let committed = initial;
    let latest = initial;
    let previews = new WeakSet<ViewportTransform>();
    return {
        current: () => latest,
        preview(next: ViewportTransform) {
            latest = next;
            previews.add(next);
        },
        commit(next: ViewportTransform) {
            if (next === committed) return;
            committed = next;
            // A known preview is an acknowledgement, not an instruction to
            // rewind. A new viewport (reset, restore, fit) still takes effect.
            if (!previews.has(next)) latest = next;
            if (next === latest) previews = new WeakSet();
        },
    };
}
