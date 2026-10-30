import { canvasGenerationDraft, canvasNodeGenerationReferences } from "./canvas-generation-record";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, CanvasStoredImageReference } from "@/types/canvas";
import type { CanvasSelectionReference } from "./canvas-selection-references";
import type { AiConfig } from "@/stores/use-config-store";

/** The editor owns mutable input; generationRecord always remains historical evidence. */
export function canvasGenerationEditorState(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], config: AiConfig) {
    const metadata = node.metadata;
    const record = metadata?.generationRecord;
    const stored = metadata?.draftImageReferences ?? record?.references;
    const references: CanvasSelectionReference[] = canvasNodeGenerationReferences(node, nodes, connections).map(reference => {
        const snapshot = stored?.find(item => item.referenceKey === reference.referenceKey);
        const sourceNodeId = snapshot?.sourceNodeId ?? (!stored && nodes.some(item => item.id === reference.id) && (reference.origin === "canvas" || reference.origin === "connection") ? reference.id : undefined);
        return { ...reference, id: reference.referenceKey, dataUrl: reference.dataUrl, url: reference.dataUrl, canvasNodeId: sourceNodeId };
    });
    return {
        prompt: canvasGenerationDraft(node), references,
        model: metadata?.model || record?.parameters.model || config.imageModel || config.model,
        size: metadata?.size || record?.parameters.size || config.size,
        quality: metadata?.quality ?? record?.parameters.quality ?? config.quality,
        imageOptions: metadata?.imageOptions ?? record?.parameters.imageOptions ?? config.imageOptions ?? "",
        count: metadata?.count ?? record?.parameters.count ?? 1,
    };
}

export function storeCanvasEditorReferences(references: readonly CanvasSelectionReference[]): CanvasStoredImageReference[] {
    return references.map(reference => ({
        id: reference.canvasNodeId || reference.id, referenceKey: reference.id,
        name: reference.name, originalFileName: reference.originalFileName, imageName: reference.imageName, imageVersion: reference.imageVersion,
        type: reference.type, content: reference.dataUrl || reference.url || "", storageKey: reference.storageKey,
        sourceNodeId: reference.canvasNodeId, origin: reference.canvasNodeId ? "canvas" : "upload",
    }));
}

export function visibleCanvasEditorReferences(references: CanvasSelectionReference[], nodes: readonly CanvasNodeData[]) {
    const ids = new Set(nodes.map(node => node.id));
    const visible = references.filter(reference => !reference.canvasNodeId || ids.has(reference.canvasNodeId));
    return visible.length === references.length ? references : visible;
}

export function canvasContinueFromImagePatch(node: CanvasNodeData): Partial<CanvasNodeMetadata> {
    return { draftPrompt: "", draftImageReferences: [{
        id: node.id, referenceKey: `source:${node.id}`, sourceNodeId: node.id, origin: "canvas",
        name: node.metadata?.originalFileName || node.title || node.id, originalFileName: node.metadata?.originalFileName,
        imageName: node.metadata?.imageName, imageVersion: node.metadata?.imageVersion,
        type: node.metadata?.mimeType || "image/png", content: node.metadata?.content || "", storageKey: node.metadata?.storageKey,
    }] };
}

/** Copies retain their origin; self-links are never rendered as descendants. */
export function canvasGenerationDerivatives(sourceId: string, nodes: readonly CanvasNodeData[]) {
    return nodes.filter(node => node.id !== sourceId && (node.metadata?.generationOrigin?.sourceNodeId || node.metadata?.generationRecord?.sourceNodeId) === sourceId);
}
