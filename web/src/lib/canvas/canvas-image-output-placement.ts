import type { CanvasNodeData, Position } from "@/types/canvas";

/** Keep edited outputs near their sources without covering existing media. */
export function placeCanvasImageOutputs(nodes: readonly CanvasNodeData[], sources: readonly CanvasNodeData[], size: { width: number; height: number }, center: Position, gap = 36, explicitPosition?: Position | null): Position {
    if (explicitPosition) return { ...explicitPosition };
    const x = sources.length ? Math.max(...sources.map((node) => node.position.x + node.width)) + gap : center.x - size.width / 2;
    let y = sources.length ? Math.min(...sources.map((node) => node.position.y)) : center.y - size.height / 2;
    for (;;) {
        const blockers = nodes.filter((node) => x < node.position.x + node.width + gap && x + size.width + gap > node.position.x && y < node.position.y + node.height + gap && y + size.height + gap > node.position.y);
        if (!blockers.length) return { x, y };
        y = Math.max(...blockers.map((node) => node.position.y + node.height)) + gap;
    }
}
