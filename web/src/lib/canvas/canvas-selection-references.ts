import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { originalCanvasImageFileName } from "@/lib/canvas/canvas-image-filename";

export type CanvasSelectionReference = ReferenceImage & { canvasNodeId?: string };

/** Selection owns canvas references; uploads stay independent. Existing order survives drag/zoom/metadata updates. */
export function syncCanvasSelectionReferences(
    current: CanvasSelectionReference[],
    selectedIds: ReadonlySet<string>,
    nodeById: ReadonlyMap<string, CanvasNodeData>,
): CanvasSelectionReference[] {
    const selected = new Map<string, CanvasSelectionReference>();
    for (const id of selectedIds) {
        const node = nodeById.get(id);
        if (node?.type !== CanvasNodeType.Image || !(node.metadata?.content || node.metadata?.storageKey)) continue;
        const content = node.metadata.content || "";
        selected.set(id, {
            id: `canvas:${id}`, canvasNodeId: id, name: node.title || "画布图片",
            type: node.metadata.mimeType || "image/png", dataUrl: content, url: content,
            storageKey: node.metadata.storageKey,
            originalFileName: originalCanvasImageFileName(node),
        });
    }
    const next: CanvasSelectionReference[] = [];
    for (const reference of current) {
        if (!reference.canvasNodeId) { next.push(reference); continue; }
        const updated = selected.get(reference.canvasNodeId);
        if (!updated) continue;
        const unchanged = reference.name === updated.name && reference.type === updated.type &&
            reference.dataUrl === updated.dataUrl && reference.url === updated.url && reference.storageKey === updated.storageKey && reference.originalFileName === updated.originalFileName;
        next.push(unchanged ? reference : updated);
        selected.delete(reference.canvasNodeId);
    }
    next.push(...selected.values());
    return next.length === current.length && next.every((reference, index) => reference === current[index]) ? current : next;
}
