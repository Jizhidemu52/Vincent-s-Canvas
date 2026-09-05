/**
 * The fallback renderer needs a full world-sized SVG because it owns every
 * connection. A live connection preview only needs one overflow-visible path,
 * so it can use a 1px SVG viewport and avoid promoting a 10000px surface.
 */
export function canvasConnectionSvgSurfaceKind(isFallback: boolean, isConnecting: boolean): "fallback" | "preview" | null {
    if (isFallback) return "fallback";
    return isConnecting ? "preview" : null;
}
