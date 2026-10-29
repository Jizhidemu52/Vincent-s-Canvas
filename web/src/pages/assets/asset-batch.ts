import { uiText } from "@/lib/i18n";
import { createClientId } from "@/lib/client-id";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

export function selectAssetRange(current: ReadonlySet<string>, orderedIds: string[], id: string, anchor: string | null, shift: boolean) {
    const next = new Set(current);
    const index = orderedIds.indexOf(id), anchorIndex = anchor ? orderedIds.indexOf(anchor) : -1;
    if (shift && index >= 0 && anchorIndex >= 0) {
        for (const value of orderedIds.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1)) next.add(value);
    } else if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size > 50) throw new Error(uiText("每次最多选择 50 个素材"));
    return next;
}

export function assetCanvasNodes(assets: Asset[], offsetY = 0): CanvasNodeData[] {
    return assets.map((asset, index) => {
        const media = asset.kind === "image" || asset.kind === "video" ? asset.data : null;
        const naturalWidth = media?.width || 320, naturalHeight = media?.height || 240;
        const scale = Math.min(320 / naturalWidth, 300 / naturalHeight, 1);
        return {
            id: createClientId(), title: asset.title,
            type: asset.kind === "image" ? CanvasNodeType.Image : asset.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Text,
            position: { x: (index % 4) * 380, y: offsetY + Math.floor(index / 4) * 380 },
            width: media ? Math.max(1, naturalWidth * scale) : 320,
            height: media ? Math.max(1, naturalHeight * scale) : 220,
            metadata: {
                content: asset.kind === "text" ? asset.data.content : asset.kind === "image" ? asset.data.dataUrl : asset.kind === "video" ? asset.data.url : "",
                ...(media ? { naturalWidth, naturalHeight, mimeType: media.mimeType, bytes: media.bytes, storageKey: media.storageKey } : {}),
                ...(typeof asset.metadata?.prompt === "string" ? { prompt: asset.metadata.prompt } : {}),
                status: "success",
            },
        };
    });
}

/** Frame a newly created selection below toolbars; never change an existing canvas viewport. */
export function assetCanvasViewport(nodes: CanvasNodeData[], size: { width: number; height: number }): ViewportTransform {
    if (!nodes.length) return { x: 0, y: 0, k: 1 };
    const left = size.width > 900 ? 360 : 24, top = 120;
    const availableWidth = Math.max(100, size.width - left - 24), availableHeight = Math.max(100, size.height - top - 100);
    const minX = Math.min(...nodes.map(node => node.position.x)), minY = Math.min(...nodes.map(node => node.position.y));
    const width = Math.max(1, Math.max(...nodes.map(node => node.position.x + node.width)) - minX);
    const height = Math.max(1, Math.max(...nodes.map(node => node.position.y + node.height)) - minY);
    const k = Math.max(0.1, Math.min(1, availableWidth / width, availableHeight / height));
    return { x: left + (availableWidth - width * k) / 2 - minX * k,
        y: top + (availableHeight - height * k) / 2 - minY * k, k };
}
