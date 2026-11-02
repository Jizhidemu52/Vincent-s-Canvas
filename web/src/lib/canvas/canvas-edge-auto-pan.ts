export type CanvasEdgeAutoPanPoint = { x: number; y: number };
export type CanvasEdgeAutoPanRect = { left: number; top: number; right: number; bottom: number };

const EDGE_BAND = 48;
const MAX_SPEED = 600;

/** Screen-pixel viewport translation: left/top edges move content right/down.
 * The caller supplies the unobscured canvas rect and applies this during active drags only.
 */
export function canvasEdgeAutoPanDelta(pointer: CanvasEdgeAutoPanPoint | null | undefined, rect: CanvasEdgeAutoPanRect | null | undefined, deltaMs: number): CanvasEdgeAutoPanPoint {
    const idle = { x: 0, y: 0 };
    if (!pointer || !rect || ![pointer.x, pointer.y, rect.left, rect.top, rect.right, rect.bottom, deltaMs].every(Number.isFinite)
        || rect.right <= rect.left || rect.bottom <= rect.top || deltaMs <= 0) return idle;
    if (pointer.x < rect.left - EDGE_BAND || pointer.x > rect.right + EDGE_BAND
        || pointer.y < rect.top - EDGE_BAND || pointer.y > rect.bottom + EDGE_BAND) return idle;
    const axis = (value: number, start: number, end: number) => {
        const band = Math.min(EDGE_BAND, (end - start) / 2);
        const proximity = value < start + band ? Math.min(1, (start + band - value) / band)
            : value > end - band ? -Math.min(1, (value - end + band) / band) : 0;
        const amount = Math.abs(proximity);
        return Math.sign(proximity) * amount * amount * (3 - 2 * amount);
    };
    const x = axis(pointer.x, rect.left, rect.right), y = axis(pointer.y, rect.top, rect.bottom);
    const distance = MAX_SPEED * Math.min(deltaMs, 50) / 1_000 / Math.max(1, Math.hypot(x, y));
    return { x: x === 0 ? 0 : x * distance, y: y === 0 ? 0 : y * distance };
}
