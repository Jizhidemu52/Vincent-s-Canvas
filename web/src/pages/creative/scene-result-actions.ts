import { nanoid } from "nanoid";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageCopyEditorNode } from "@/lib/image-edit-copy";
import { canvasImageDownloadFileName } from "@/lib/canvas/canvas-image-filename";
import { uploadServerAsset } from "@/services/api/server-assets";
import { rememberMediaSource } from "@/services/canvas-media-links";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType } from "@/types/canvas";
import type { SceneImage, SceneLog } from "./use-scene-workspace";

export function sceneReferenceUrl(assetId: string, ownerId: string, prompt: string, model: string) {
    return `/image?${new URLSearchParams({ tool: "image-edit", sourceAssetId: assetId, sourceOwnerId: ownerId, prompt, model })}`;
}

/** Per-workspace cache and stable upload identity avoid duplicate assets after repeat clicks. */
export function createSceneResultActions(ownerId: string) {
    const assets = new Map<string, Promise<string>>();
    const canvases = new Map<string, string>();
    const assertOwner = () => { const user = useUserStore.getState().user; if (user?.id !== ownerId || user.status !== "active") throw new Error("当前账号已变化，已停止结果操作"); };
    const saveAsset = (image: SceneImage, log: SceneLog) => {
        assertOwner();
        const key = `${log.id}:${image.id}`;
        const existing = assets.get(key); if (existing) return existing;
        const pending = (async () => {
            const url = await resolveImageUrl(image.storageKey, image.dataUrl); assertOwner();
            if (!url) throw new Error("原图已不可用");
            const response = await fetch(url); if (!response.ok) throw new Error(`原图读取失败（${response.status}）`);
            const blob = await response.blob(); assertOwner();
            const name = canvasImageDownloadFileName(imageCopyEditorNode({ ...image, title: image.name, mimeType: blob.type || image.mimeType }));
            const id = await uploadServerAsset(new File([blob], name, { type: blob.type || image.mimeType }), {
                title: image.name, source: "creative-scene", module: log.sceneId, prompt: log.prompt, model: log.config.imageModel,
                sourceTaskId: image.sourceTaskId, toolMode: "image-edit", naturalWidth: image.width, naturalHeight: image.height,
            }, { expectedOwnerId: ownerId, clientReferenceId: `creative:${ownerId}:${key}` });
            assertOwner(); return id;
        })();
        assets.set(key, pending); void pending.catch(() => { if (assets.get(key) === pending) assets.delete(key); }); return pending;
    };
    return {
        saveAsset,
        async reference(image: SceneImage, log: SceneLog) { return sceneReferenceUrl(await saveAsset(image, log), ownerId, log.prompt, log.config.imageModel); },
        async canvas(image: SceneImage, log: SceneLog) {
            assertOwner(); if (!useCanvasStore.getState().hydrated) throw new Error("个人画布正在加载，请稍后重试");
            const key = `${log.id}:${image.id}`;
            let id = canvases.get(key);
            if (!id || !useCanvasStore.getState().openProject(id)) {
                const assetId = await saveAsset(image, log);
                const stored = await uploadImage(image.dataUrl); assertOwner();
                await rememberMediaSource(stored.storageKey, `/api/assets/${encodeURIComponent(assetId)}/content`); assertOwner();
                if (!useCanvasStore.getState().hydrated) throw new Error("个人画布状态已变化，请稍后重试");
                const size = fitNodeSize(stored.width, stored.height);
                id = useCanvasStore.getState().importProject({ title: `${image.name || "创意结果"} · 继续创作`, nodes: [{ id: nanoid(), type: CanvasNodeType.Image, title: image.name,
                    ...size, position: { x: 80, y: 80 }, metadata: { content: stored.url, storageKey: stored.storageKey, status: "success", naturalWidth: stored.width, naturalHeight: stored.height,
                        mimeType: stored.mimeType, bytes: stored.bytes, prompt: log.prompt, model: log.config.imageModel, sourceTaskId: image.sourceTaskId, originalFileName: image.originalFileName, imageName: image.imageName } }] });
                canvases.set(key, id);
            }
            try { await flushCanvasPersistence(); } catch { throw new Error("图片已加入画布，但保存未完成。请保留页面，再点此按钮重试保存，不会重复添加。 "); }
            assertOwner(); return `/canvas/${encodeURIComponent(id)}`;
        },
    };
}
