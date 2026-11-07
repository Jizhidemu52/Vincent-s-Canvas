import type { RefObject } from "react";
import { videoFileExtension } from "../../../../shared/video-output";
import type { useCanvasExport } from "@/hooks/use-canvas-export";
import { uiText } from "@/lib/i18n";
import { audioExtension, loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { resolveMediaUrl } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";
import type { App } from "antd";
import type { useCanvasDialogs } from "./use-canvas-dialogs";
import type { CanvasHistoryEntry, useCanvasHistoryState } from "./use-canvas-history";

export async function downloadCanvasEditorNode(node: CanvasNodeData, options: {
    projectId: string; nodesRef: RefObject<CanvasNodeData[]>; savedProjectIdRef: RefObject<string>;
    message: ReturnType<typeof App.useApp>["message"]; setImageDownload: ReturnType<typeof useCanvasDialogs>["setImageDownload"];
}) {
    if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
    const identity = useUserStore.getState();
    const ownerId = identity.user?.id, ownerStatus = identity.status;
    const done = options.message.loading({ content: uiText("正在准备下载…"), duration: 0 });
    try {
        const { downloadCanvasContent, loadCanvasImageVariants } = await loadCanvasExport();
        if (node.type === CanvasNodeType.Image) {
            const variants = await loadCanvasImageVariants(node);
            const current = options.nodesRef.current.find(item => item.id === node.id);
            if (options.savedProjectIdRef.current !== options.projectId || !current || current.metadata?.content !== node.metadata.content || current.metadata?.storageKey !== node.metadata.storageKey) return;
            options.setImageDownload({ projectId: options.projectId, node: current, variants });
        } else {
            const content = await resolveMediaUrl(node.metadata.storageKey, node.metadata.content);
            const current = options.nodesRef.current.find(item => item.id === node.id), session = useUserStore.getState();
            if (session.user?.id !== ownerId || session.status !== ownerStatus || options.savedProjectIdRef.current !== options.projectId || !current || current.metadata?.content !== node.metadata.content || current.metadata?.storageKey !== node.metadata.storageKey) return;
            const title = (node.title || (node.type === CanvasNodeType.Video ? uiText("画布视频") : uiText("画布音频"))).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "");
            const extension = node.type === CanvasNodeType.Video ? videoFileExtension(node.metadata.mimeType) : audioExtension(node.metadata.mimeType), name = title || uiText("画布素材");
            downloadCanvasContent(content, name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`);
        }
    } finally { done(); }
}

/** Export a revoked editor's memory only; never flush its shared save queue. */
export async function backupCanvasEditorDraft(options: {
    projectId: string; defaultTitle: string;
    flushEditorDrafts: () => void; flushPendingHistory: () => void; createHistoryEntry: () => CanvasHistoryEntry;
    historyRef: ReturnType<typeof useCanvasHistoryState>["historyRef"]; viewportRef: RefObject<ViewportTransform>;
    exportProjects: ReturnType<typeof useCanvasExport>;
}) {
    options.flushEditorDrafts();
    options.flushPendingHistory();
    const stored = useCanvasStore.getState().projects.find(project => project.id === options.projectId);
    if (!stored) throw new Error("画布草稿尚未就绪，未载入最新内容。");
    const latest = { ...stored, ...options.createHistoryEntry(), history: options.historyRef.current, viewport: options.viewportRef.current };
    if (!await options.exportProjects([latest.id], `${latest.title || options.defaultTitle}-本页未保存备份`, [latest])) {
        throw new Error("备份未完成，已保留本页草稿；请重试后再载入最新内容。");
    }
}
