/**
 * The spatial index intentionally keeps an overscan band mounted so a fast
 * pan never exposes empty space. Let supporting browsers skip the inner paint
 * work for nodes that remain outside the actual viewport.
 */
export const canvasNodeRenderingStyle = {
    contain: "layout style",
    contentVisibility: "auto",
} as const;
