import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { canvasImageBaseName, canvasImageVersion, originalCanvasImageFileName } from "@/lib/canvas/canvas-image-filename";

export type CanvasSelectionReference = ReferenceImage & { canvasNodeId?: string };

/** Selection appends references; removal is an explicit tray action, never a canvas side effect. */
export function syncCanvasSelectionReferences(
    current: CanvasSelectionReference[],
    selectedIds: ReadonlySet<string>,
    nodeById: ReadonlyMap<string, CanvasNodeData>,
): CanvasSelectionReference[] {
    const selected = new Map<string, CanvasSelectionReference>();
    const imageIds = Array.from(selectedIds).filter(id => {
        const node = nodeById.get(id);
        return node?.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey);
    });
    const referenceIds = new Set([...current.flatMap(reference => reference.canvasNodeId ? [reference.canvasNodeId] : []), ...imageIds]);
    for (const id of referenceIds) {
        const node = nodeById.get(id);
        if (node?.type !== CanvasNodeType.Image || !(node.metadata?.content || node.metadata?.storageKey)) continue;
        const content = node.metadata.content || "";
        selected.set(id, {
            id: `canvas:${id}`, canvasNodeId: id, name: node.title || "画布图片",
            type: node.metadata.mimeType || "image/png", dataUrl: content, url: content,
            storageKey: node.metadata.storageKey,
            originalFileName: originalCanvasImageFileName(node),
            imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node),
        });
    }
    const next: CanvasSelectionReference[] = [];
    for (const reference of current) {
        if (!reference.canvasNodeId) { next.push(reference); continue; }
        const updated = selected.get(reference.canvasNodeId);
        // A removed canvas node does not invalidate its already attached image snapshot.
        if (!updated) { next.push(reference); continue; }
        const unchanged = reference.name === updated.name && reference.type === updated.type &&
            reference.dataUrl === updated.dataUrl && reference.url === updated.url && reference.storageKey === updated.storageKey && reference.originalFileName === updated.originalFileName && reference.imageName === updated.imageName && reference.imageVersion === updated.imageVersion;
        next.push(unchanged ? reference : { ...updated, role: reference.role });
        selected.delete(reference.canvasNodeId);
    }
    next.push(...selected.values());
    return next.length === current.length && next.every((reference, index) => reference === current[index]) ? current : next;
}
