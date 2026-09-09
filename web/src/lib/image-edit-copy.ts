import { canvasImageBaseName, canvasImageExportStem, canvasImageVersion } from "@/lib/canvas/canvas-image-filename";
import type { UploadedImage } from "@/services/image-storage";
import type { Asset, AssetInput } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function imageCopyEditorNode(image: { id: string; title: string; dataUrl: string; storageKey?: string; width: number; height: number; mimeType?: string; imageName?: string; imageVersion?: number; originalFileName?: string }): CanvasNodeData {
    return { id: image.id, type: CanvasNodeType.Image, title: image.title, position: { x: 0, y: 0 }, width: image.width || 1, height: image.height || 1,
        metadata: { content: image.dataUrl, storageKey: image.storageKey, mimeType: image.mimeType, imageName: image.imageName, imageVersion: image.imageVersion, originalFileName: image.originalFileName } };
}

export type ImageCopySource = { node: CanvasNodeData; originId?: string; sourceAssetId?: string; sourceTaskId?: string; prompt?: string; model?: string; tags?: string[]; note?: string };
export type SavedImageCopy = { assetId: string; node: CanvasNodeData; originId: string };

/** One editor opening owns one new copy; retries never overwrite or duplicate it. */
export function createImageEditCopySession(source: ImageCopySource, ownerId: string) {
    let active = true;
    let saved: SavedImageCopy | undefined;
    return {
        node: source.node,
        invalidate() { active = false; },
        save(image: UploadedImage, currentOwnerId: string, assets: readonly Asset[], addAsset: (asset: AssetInput) => string): SavedImageCopy {
            if (!active) throw new Error("编辑会话已失效，请重新打开原图");
            if (currentOwnerId !== ownerId) throw new Error("账号已切换，请重新打开原图后保存");
            if (saved) return saved;
            const originId = source.originId || source.sourceAssetId || source.node.id;
            const siblings = assets.filter(asset => asset.ownerId === ownerId && asset.metadata?.imageOriginId === originId);
            const version = Math.max(canvasImageVersion(source.node), ...siblings.map(asset => Number(asset.metadata?.imageVersion) || 1)) + 1;
            const node = { ...source.node, width: image.width, height: image.height, metadata: { ...source.node.metadata, content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType, imageName: canvasImageBaseName(source.node), imageVersion: version } };
            node.title = canvasImageExportStem(node);
            const assetId = addAsset({ kind: "image", ownerId, title: node.title, coverUrl: image.url, tags: [...(source.tags || [])], source: "原图手动编辑", note: source.note,
                data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType },
                // Do not inherit server identity, ownership, sharing, or approval status from the original.
                metadata: { source: "manual-image-edit", module: "图片编辑", imageName: node.metadata.imageName, imageVersion: version, imageOriginId: originId, parentImageId: source.node.id, sourceAssetId: source.sourceAssetId, sourceTaskId: source.sourceTaskId, prompt: source.prompt, model: source.model, designerId: ownerId } });
            saved = { assetId, node: { ...node, id: assetId }, originId };
            return saved;
        },
    };
}
