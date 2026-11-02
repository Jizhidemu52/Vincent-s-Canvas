import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";

/** Keep edited outputs near their sources without covering existing media. */
export function placeCanvasImageOutputs(nodes: readonly CanvasNodeData[], sources: readonly CanvasNodeData[], size: { width: number; height: number }, center: Position, gap = 36, explicitPosition?: Position | null): Position {
    if (explicitPosition) return { ...explicitPosition };
    const images = sources.filter(node => node.type === CanvasNodeType.Image);
    const anchors = images.length ? images : sources;
    const anchor = anchors[0];
    const origin = anchor ? { x: anchor.position.x + anchor.width + gap, y: anchor.position.y } : { x: center.x - size.width / 2, y: center.y - size.height / 2 };
    const clear = (point: Position) => !nodes.some(node => point.x < node.position.x + node.width + gap && point.x + size.width + gap > node.position.x && point.y < node.position.y + node.height + gap && point.y + size.height + gap > node.position.y);
    // Search nearest rings, never push a single column arbitrarily far down the canvas.
    const dx = size.width + gap, dy = size.height + gap;
    for (let ring = 0; ring <= Math.ceil(Math.sqrt(nodes.length + 1)) + 2; ring++) {
        const candidates: Position[] = [];
        for (let row = -ring; row <= ring; row++) for (let col = 0; col <= ring; col++) {
            if (Math.max(Math.abs(row), col) !== ring) continue;
            candidates.push({ x: origin.x + col * dx, y: origin.y + row * dy });
        }
        candidates.sort((a, b) => Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y) || b.y - a.y);
        const available = candidates.find(clear);
        if (available) return available;
    }
    // A huge node may cover many grid cells; its right edge is a finite safe fallback.
    return { x: Math.max(origin.x, ...nodes.map(node => node.position.x + node.width + gap)), y: origin.y };
}
