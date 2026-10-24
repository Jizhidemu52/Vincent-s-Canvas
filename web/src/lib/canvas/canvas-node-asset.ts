import { getDataUrlByteSize } from "@/lib/image-utils";
import type { AssetInput } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasImageBaseName, canvasImageExportStem, canvasImageVersion } from "./canvas-image-filename";

/** Asset preparation is loaded only when a user explicitly saves a canvas node. */
export function createCanvasNodeAsset(node: CanvasNodeData, projectId: string): AssetInput {
    const metadata = {
        source: "canvas", module: "无线画布", nodeId: node.id,
        prompt: node.metadata?.prompt, model: node.metadata?.model, projectId,
    };
    const shared = { coverUrl: "", tags: [], source: "无线画布", metadata };
    if (node.type === CanvasNodeType.Text) {
        const content = node.metadata?.content?.trim();
        if (!content) throw new Error("没有可保存的文本");
        return { ...shared, kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", data: { content } };
    }
    const query = `prompt=${encodeURIComponent(String(node.metadata?.prompt || ""))}&model=${encodeURIComponent(String(node.metadata?.model || ""))}`;
    if (node.type === CanvasNodeType.Video) {
        if (!node.metadata?.content) throw new Error("没有可保存的视频");
        return {
            ...shared, kind: "video", title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
            data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
            metadata: { ...metadata, recreatePath: `/video?${query}` },
        };
    }
    if (!node.metadata?.content) throw new Error("没有可保存的图片");
    const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
    return {
        ...shared, kind: "image", title: canvasImageExportStem(node), coverUrl: node.metadata.content,
        data: {
            dataUrl, storageKey: node.metadata.storageKey,
            width: node.metadata.naturalWidth || node.width, height: node.metadata.naturalHeight || node.height,
            bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl), mimeType: node.metadata.mimeType || "image/png",
        },
        metadata: {
            ...metadata, recreatePath: `/image?tool=${node.metadata?.generationType === "edit" ? "image-edit" : "image-generation"}&${query}`,
            imageName: canvasImageBaseName(node), imageVersion: canvasImageVersion(node),
        },
    };
}
