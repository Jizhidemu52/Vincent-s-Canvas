import { useRef, useState } from "react";
import { App } from "antd";
import { useNavigate } from "react-router-dom";
import { nanoid } from "nanoid";
import { uiText } from "@/lib/i18n";
import { generationErrorMessage, generationDownloadName } from "@/lib/generation-feedback";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useUserStore } from "@/stores/use-user-store";
import { flushCanvasPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { uploadServerAsset } from "@/services/api/server-assets";
import { rememberMediaSource } from "@/services/canvas-media-links";
import { CanvasNodeType } from "@/types/canvas";

type ResultMedia = { id: string; kind: "image" | "video"; url: string; storageKey?: string; title: string; prompt?: string; model?: string; sourceTaskId?: string; width: number; height: number; mimeType?: string };

/** Explicit result action. A failed save retries the same project instead of importing a duplicate. */
export function useResultCanvas() {
    const ownerId = useUserStore(state => state.user?.id);
    const enabled = useModuleEnabled("canvas");
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [busy, setBusy] = useState(false);
    const working = useRef(false);
    const projects = useRef(new Map<string, string>());
    const place = async (media: ResultMedia) => {
        if (working.current || !enabled) return;
        const assertOwner = () => { if (!ownerId || useUserStore.getState().user?.id !== ownerId || useUserStore.getState().user?.status !== "active") throw new Error("当前账号已变化，请重新进入工作区"); };
        working.current = true; setBusy(true);
        try {
            assertOwner();
            if (!useCanvasStore.getState().hydrated) throw new Error("画布记录仍在读取，请稍后再试");
            const key = `${ownerId}:${media.kind}:${media.id}`;
            let projectId = projects.current.get(key);
            if (!projectId || !useCanvasStore.getState().openProject(projectId)) {
                const url = media.kind === "image" ? await resolveImageUrl(media.storageKey, media.url) : await resolveMediaUrl(media.storageKey, media.url);
                const response = await fetch(url);
                if (!response.ok) throw new Error(`原始素材读取失败（${response.status}）`);
                const blob = await response.blob(); assertOwner();
                if (!blob.type.startsWith(`${media.kind}/`)) throw new Error("返回内容不是可用的原始素材");
                const filename = generationDownloadName(media.title, media.kind === "video" ? "mp4" : blob.type.split("/")[1] || "png");
                const assetId = await uploadServerAsset(new File([blob], filename, { type: blob.type }), { title: media.title, source: "generation", prompt: media.prompt, model: media.model, sourceTaskId: media.sourceTaskId }, { expectedOwnerId: ownerId, clientReferenceId: `result-canvas:${key}` });
                assertOwner();
                const stored = media.kind === "image" ? await uploadImage(blob) : await uploadMediaFile(blob, "video");
                await rememberMediaSource(stored.storageKey, `/api/assets/${encodeURIComponent(assetId)}/content`);
                assertOwner();
                const size = fitNodeSize(media.width || 640, media.height || 640);
                projectId = useCanvasStore.getState().importProject({ title: media.title, nodes: [{ id: nanoid(), type: media.kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Video, title: media.title, ...size, position: { x: 80, y: 80 }, metadata: { content: stored.url, storageKey: stored.storageKey, status: "success", naturalWidth: media.width, naturalHeight: media.height, mimeType: blob.type, bytes: blob.size, prompt: media.prompt, model: media.model, sourceTaskId: media.sourceTaskId } }] });
                projects.current.set(key, projectId);
            }
            await flushCanvasPersistence(); assertOwner();
            navigate(`/canvas/${encodeURIComponent(projectId)}`);
        } catch (error) { message.error(uiText(generationErrorMessage(error))); }
        finally { working.current = false; setBusy(false); }
    };
    return { enabled, busy, place };
}
