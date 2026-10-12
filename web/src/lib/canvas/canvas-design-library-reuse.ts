import { nanoid } from "nanoid";
import { createClientId } from "@/lib/client-id";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { fetchDesignLibraryReusedImage, recordDesignLibraryEvent, requireDesignLibraryOwner, reuseDesignLibraryImage } from "@/services/api/design-library";
import { rememberMediaSource } from "@/services/canvas-media-links";
import { uploadImage } from "@/services/image-storage";
import { flushCanvasPersistence, loadCanvasProject, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { DesignLibraryEntry, DesignLibraryImage } from "@/types/design-library";

export class DesignLibraryCanvasPersistenceError extends Error {
    constructor(public readonly projectId: string, cause: unknown) {
        super("图片已加入画布，但画布尚未保存成功。请保留当前页面并重试保存，勿重复添加图片。", { cause });
        this.name = "DesignLibraryCanvasPersistenceError";
    }
}

/** Copy original bytes into the employee's own media and append only after a fresh graph read. */
export async function addDesignLibraryImageToCanvas(entry: DesignLibraryEntry, image: DesignLibraryImage, targetProjectId?: string): Promise<{ projectId: string; trackingRecorded: boolean }> {
    const owner = requireDesignLibraryOwner();
    if (!useCanvasStore.getState().hydrated) throw new Error("个人画布仍在加载，请稍后重试");
    if (entry.status !== "published" || !entry.images.some(item => item.id === image.id)) throw new Error("该共享图片当前不可复用，请刷新作品详情");
    if (targetProjectId) {
        if (!await loadCanvasProject(targetProjectId)) throw new Error("目标画布已不存在，请重新选择");
        requireDesignLibraryOwner(false, owner);
    }

    const requestId = createClientId();
    const options = { expectedOwnerId: owner };
    const reuse = await reuseDesignLibraryImage(entry.id, image.id, requestId, options);
    requireDesignLibraryOwner(false, owner);
    const blob = await fetchDesignLibraryReusedImage(reuse.assetId, options);
    requireDesignLibraryOwner(false, owner);
    const stored = await uploadImage(blob);
    requireDesignLibraryOwner(false, owner);
    // Reuse the independent server copy for cloud persistence; never the author's private asset.
    await rememberMediaSource(stored.storageKey, `/api/assets/${encodeURIComponent(reuse.assetId)}/content`);
    requireDesignLibraryOwner(false, owner);

    const state = useCanvasStore.getState();
    if (!state.hydrated) throw new Error("个人画布状态已变化，请重新进入后再试");
    const projectId = targetProjectId || state.createProject(`${entry.title} · 继续创作`);
    const project = useCanvasStore.getState().openProject(projectId);
    if (!project) throw new Error("目标画布已被删除，图片未加入画布");
    const size = fitNodeSize(stored.width, stored.height);
    const viewport = project.viewport;
    const scale = Number.isFinite(viewport.k) && viewport.k > 0 ? viewport.k : 1;
    const center = {
        x: ((typeof window === "undefined" ? 1200 : window.innerWidth) / 2 - viewport.x) / scale,
        y: ((typeof window === "undefined" ? 800 : window.innerHeight) / 2 - viewport.y) / scale,
    };
    const node: CanvasNodeData = {
        id: nanoid(), type: CanvasNodeType.Image, title: reuse.image.filename || entry.title,
        position: placeCanvasImageOutputs(project.nodes, [], size, center), ...size,
        metadata: {
            content: stored.url, storageKey: stored.storageKey, status: "success",
            originalFileName: reuse.image.filename, imageName: entry.title,
            naturalWidth: stored.width, naturalHeight: stored.height, mimeType: stored.mimeType, bytes: stored.bytes,
            designLibrarySource: { entryId: reuse.source.entryId, imageId: reuse.source.imageId, title: reuse.source.title, authorName: reuse.source.authorName, assetId: reuse.assetId },
        },
    };
    // No await between the latest project read and this field-only patch. Concurrent edits survive.
    useCanvasStore.getState().updateProject(projectId, { nodes: [...project.nodes, node] });
    try {
        await flushCanvasPersistence();
    } catch (error) {
        requireDesignLibraryOwner(false, owner);
        throw new DesignLibraryCanvasPersistenceError(projectId, error);
    }
    requireDesignLibraryOwner(false, owner);
    const saved = useCanvasStore.getState().openProject(projectId);
    if (!saved?.nodes.some(item => item.id === node.id)) throw new Error("目标画布或新图片已被删除，未记录复用成功");

    let trackingRecorded = false;
    try {
        await recordDesignLibraryEvent(entry.id, { action: "reuse", imageId: image.id, requestId, reusedAssetId: reuse.assetId }, options);
        // recorded:false is also a successful response (author actions / duplicate receipt excluded).
        trackingRecorded = true;
    } catch {
        // The canvas is already durable. A receipt failure must not invite duplicate creation.
    }
    requireDesignLibraryOwner(false, owner);
    return { projectId, trackingRecorded };
}
