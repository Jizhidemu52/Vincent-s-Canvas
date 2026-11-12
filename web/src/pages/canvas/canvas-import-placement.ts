import type { CanvasNodeData } from "@/types/canvas";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";

/** Preserve a batch's grid and media bytes; move only the batch when it would cover existing content. */
export function placeCanvasImportedNodes(existing: readonly CanvasNodeData[], imported: CanvasNodeData[], append = false): CanvasNodeData[] {
    if (!existing.length || !imported.length) return imported;
    const left = Math.min(...imported.map(node => node.position.x));
    const top = Math.min(...imported.map(node => node.position.y));
    const width = Math.max(...imported.map(node => node.position.x + node.width)) - left;
    const height = Math.max(...imported.map(node => node.position.y + node.height)) - top;
    const gap = 36;
    const collides = imported.some(node => existing.some(item => node.position.x < item.position.x + item.width + gap && node.position.x + node.width + gap > item.position.x && node.position.y < item.position.y + item.height + gap && node.position.y + node.height + gap > item.position.y));
    if (!append && !collides) return imported;
    const rightmost = existing.reduce((right, node) => node.position.x + node.width > right.position.x + right.width ? node : right);
    const target = placeCanvasImageOutputs(existing, [rightmost], { width, height }, { x: left + width / 2, y: top + height / 2 }, gap);
    return imported.map(node => ({ ...node, position: { x: target.x + node.position.x - left, y: target.y + node.position.y - top } }));
}
