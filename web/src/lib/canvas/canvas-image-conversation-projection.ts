import type { PublicImageVersion } from "../../../../shared/image-conversation-public";
import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { fitNodeSize } from "./canvas-node-size";
import { placeCanvasImageOutputs } from "./canvas-image-output-placement";

export function projectCanvasImageConversationVersion(nodes: CanvasNodeData[], version: PublicImageVersion, center: Position): CanvasNodeData[] {
    if (version.source !== "generated" || !version.turnId) return nodes;
    const existing = nodes.find(node => node.metadata?.imageConversation?.conversationId === version.conversationId && node.metadata.imageConversation.versionId === version.id);
    if (existing) {
        if (existing.metadata!.imageConversation!.assetId !== version.assetId) throw new Error("图片版本身份与已保存画布记录不一致，未替换原图。");
        return nodes;
    }
    const dimensions = version.actualDimensions;
    if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("服务端图片实际尺寸尚未确认，未写入画布。");
    const size = fitNodeSize(dimensions.width, dimensions.height);
    const parent = nodes.find(node => node.metadata?.imageConversation?.conversationId === version.conversationId && node.metadata.imageConversation.versionId === version.parentVersionId);
    const node: CanvasNodeData = {
        id: `conversation-image:${version.conversationId}:${version.id}`,
        type: CanvasNodeType.Image,
        title: `图${version.imageNo} · ${version.label}`,
        position: placeCanvasImageOutputs(nodes, parent ? [parent] : [], size, center),
        ...size,
        metadata: { content: `/api/assets/${encodeURIComponent(version.assetId)}/content`, serverAssetId: version.assetId, status: "success",
            naturalWidth: dimensions.width, naturalHeight: dimensions.height, imageVersion: version.versionNo, imageName: version.label,
            imageConversation: { conversationId: version.conversationId, versionId: version.id, assetId: version.assetId, turnId: version.turnId } },
    };
    return [...nodes, node];
}
