import { isEmptyCanvasDesignTemplateReference } from "@/lib/canvas/canvas-design-template-reference";
import { readImageMeta } from "@/lib/image-utils";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { replaceCanvasNodeImage } from "./canvas-project-utils";

type TemplateReferenceGraph = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; writable: boolean };

/** The click-time snapshot is captured before this lazy runtime loads; commit stays synchronous after revalidation. */
export async function promoteCanvasTemplateReference(nodeId: string, referenceKey: string, originalGraph: TemplateReferenceGraph, currentGraph: () => TemplateReferenceGraph, commit: (node: CanvasNodeData) => void) {
    const original = originalGraph.nodes.find(node => node.id === nodeId);
    const reference = original?.metadata?.manualImageReferences?.length === 1 ? original.metadata.manualImageReferences[0] : undefined;
    if (!originalGraph.writable || !original || !isEmptyCanvasDesignTemplateReference(original, originalGraph.nodes, originalGraph.connections) || reference?.referenceKey !== referenceKey) throw new Error("参考款或附加参考图已变化，请重新打开后操作");
    const url = await resolveImageUrl(reference.storageKey, reference.content);
    if (!url) throw new Error("参考图无法读取，请重新上传参考款原图");
    const image = reference.storageKey ? {
        ...await readImageMeta(url), url, storageKey: reference.storageKey, mimeType: reference.type,
        bytes: (await getImageBlob(reference.storageKey))?.size || 0,
    } : await uploadImage(url);
    const latest = currentGraph();
    const current = latest.nodes.find(node => node.id === nodeId);
    if (!latest.writable || !current || !isEmptyCanvasDesignTemplateReference(current, latest.nodes, latest.connections)
        || JSON.stringify(current.metadata?.manualImageReferences) !== JSON.stringify(original.metadata?.manualImageReferences)) throw new Error("参考款已变化，本次设置已取消，请重新操作");
    commit(replaceCanvasNodeImage(current, { ...image, originalFileName: reference.originalFileName || reference.name }, reference.imageName || reference.name));
}
