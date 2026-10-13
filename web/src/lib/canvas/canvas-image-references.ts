import { createImageReferenceItem, dedupeImageReferences } from "@/lib/image-reference-policy";
import { getGenerationResourceNodes, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasStoredImageReference } from "@/types/canvas";
import type { ImageReferenceItem } from "@/types/image";
import { canvasImageBaseName, canvasImageVersion } from "./canvas-image-filename";

export function resolveCanvasImageReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): ImageReferenceItem[] {
    const manual = (node.metadata?.manualImageReferences || []).map(toReferenceItem);
    const excluded = new Set(node.metadata?.excludedConnectedImageReferenceKeys || []);
    const connected = getGenerationResourceNodes(node.id, nodes, connections)
        .filter((candidate) => candidate.type === CanvasNodeType.Image && Boolean(candidate.metadata?.content))
        .map((candidate) => createImageReferenceItem({ id: candidate.id, name: candidate.metadata?.originalFileName || candidate.title || candidate.id, originalFileName: candidate.metadata?.originalFileName, imageName: canvasImageBaseName(candidate), imageVersion: canvasImageVersion(candidate), type: candidate.metadata?.mimeType || "image/png", dataUrl: candidate.metadata!.content!, storageKey: candidate.metadata?.storageKey }, "connection"))
        .map((reference) => ({ ...reference, referenceKey: `node:${reference.id}` }))
        .filter((reference) => !excluded.has(reference.referenceKey));
    return applyCanvasReferenceOrder(dedupeImageReferences([...manual, ...connected]), node.metadata?.imageReferenceOrder || []);
}

/** The node-edit tray, mentions and generation request share this exact input order. */
export function resolveCanvasNodeImageReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): ImageReferenceItem[] {
    const references = resolveCanvasImageReferences(node, nodes, connections);
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return references;
    const source = {
        ...createImageReferenceItem({ id: node.id, name: node.metadata.originalFileName || node.title || node.id, originalFileName: node.metadata.originalFileName,
            imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node), type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }, "canvas"),
        referenceKey: `source:${node.id}`, originLabel: "当前原图",
    };
    return dedupeImageReferences([source, ...references.filter(reference => reference.id !== node.id && reference.dataUrl !== source.dataUrl)]);
}

export function canvasImageReferenceMentions(references: ImageReferenceItem[]): CanvasResourceReference[] {
    return references.map((reference, index) => ({ id: reference.referenceKey, nodeId: reference.id, kind: "image",
        label: imageReferenceLabel(index), title: reference.name, previewUrl: reference.dataUrl, active: true }));
}

export function applyCanvasReferenceOrder(references: ImageReferenceItem[], order: string[]) {
    const rank = new Map(order.map((key, index) => [key, index]));
    return [...references].sort((left, right) => {
        const leftRank = rank.get(left.referenceKey);
        const rightRank = rank.get(right.referenceKey);
        if (leftRank === undefined && rightRank === undefined) return 0;
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
    });
}

export function excludeConnectedReference(metadata: CanvasNodeMetadata, referenceKey: string): CanvasNodeMetadata {
    return { ...metadata, excludedConnectedImageReferenceKeys: Array.from(new Set([...(metadata.excludedConnectedImageReferenceKeys || []), referenceKey])) };
}

export function toCanvasStoredImageReference(reference: ImageReferenceItem): CanvasStoredImageReference {
    return { referenceKey: reference.referenceKey, id: reference.id, name: reference.name, originalFileName: reference.originalFileName, imageName: reference.imageName, imageVersion: reference.imageVersion, type: reference.type, content: reference.dataUrl, storageKey: reference.storageKey, sourceNodeId: reference.origin === "canvas" ? reference.id : undefined, origin: reference.origin === "asset" ? "asset" : reference.origin === "canvas" ? "canvas" : "upload" };
}

function toReferenceItem(reference: CanvasStoredImageReference): ImageReferenceItem {
    return { ...createImageReferenceItem({ id: reference.id, name: reference.name, originalFileName: reference.originalFileName, imageName: reference.imageName, imageVersion: reference.imageVersion, type: reference.type, dataUrl: reference.content, storageKey: reference.storageKey }, reference.origin === "asset" ? "asset" : reference.origin === "canvas" ? "canvas" : "upload"), referenceKey: reference.referenceKey };
}
