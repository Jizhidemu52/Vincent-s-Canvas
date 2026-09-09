import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { UploadedImage } from "@/services/image-storage";
import { canvasImageBaseName, canvasImageVersion, originalCanvasImageFileName } from "./canvas-image-filename";

/** Keep node IDs/connections stable and synchronize the primary image of a collapsed batch. */
export function applyCanvasImageEdit(nodes: CanvasNodeData[], original: CanvasNodeData, image: UploadedImage) {
    const current = nodes.find(node => node.id === original.id);
    if (!current || current.type !== CanvasNodeType.Image) throw new Error("原图片节点已被移除，无法保存编辑");
    if (current.metadata?.storageKey === image.storageKey) return nodes; // A persistence retry, not a second edit.
    if (current.metadata?.storageKey !== original.metadata?.storageKey || current.metadata?.content !== original.metadata?.content) {
        throw new Error("原图片已发生变化，请取消后重新打开编辑，避免覆盖新结果");
    }
    const affected = new Set([current.id]);
    if (current.metadata?.isBatchRoot && current.metadata.primaryImageId) affected.add(current.metadata.primaryImageId);
    const root = current.metadata?.batchRootId ? nodes.find(node => node.id === current.metadata?.batchRootId) : undefined;
    if (root?.metadata?.primaryImageId === current.id) affected.add(root.id);
    return nodes.map(node => {
        if (!affected.has(node.id)) return node;
        const originalName = originalCanvasImageFileName(node) || "edited-image";
        return { ...node, height: node.width * image.height / image.width, metadata: {
            ...node.metadata, content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height,
            mimeType: image.mimeType, bytes: image.bytes, status: "success" as const, errorDetails: undefined, freeResize: false,
            originalFileName: originalName.replace(/\.[^.]+$/, "") + ".png",
            imageName: canvasImageBaseName(current), imageVersion: canvasImageVersion(current) + 1,
        } };
    });
}

export function rollbackCanvasImageEdit(nodes: CanvasNodeData[], before: CanvasNodeData[], storageKey: string) {
    const originals = new Map(before.map(node => [node.id, node]));
    return nodes.map(node => node.metadata?.storageKey === storageKey ? originals.get(node.id) || node : node);
}
