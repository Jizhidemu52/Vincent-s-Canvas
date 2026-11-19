import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PublicImageVersion } from "../../../../shared/image-conversation-public";
import type { CanvasAssistantSession, CanvasNodeData, Position } from "@/types/canvas";
import type { CanvasProjectPatch } from "@/lib/canvas/canvas-project-update";
import { projectCanvasImageConversationVersion } from "@/lib/canvas/canvas-image-conversation-projection";
import { flushCanvasPersistence } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

export type CanvasConversationRuntime = {
    ownerId?: string;
    projectId: string;
    designProjectIdRef: RefObject<string>;
    savedProjectIdRef: RefObject<string>;
    nodesRef: RefObject<CanvasNodeData[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    projectSaveQueueRef: RefObject<{ flush(): void } | null>;
    updateProject: (id: string, patch: CanvasProjectPatch) => void;
    setChatSessions: Dispatch<SetStateAction<CanvasAssistantSession[]>>;
    setActiveChatId: Dispatch<SetStateAction<string | null>>;
    runtime: { isObservationCurrent: () => boolean; waitForWriteAccess: () => Promise<boolean> };
    containerRef: RefObject<HTMLElement | null>;
    screenToCanvas: (x: number, y: number) => Position;
    size: { width: number; height: number };
};

function current(context: CanvasConversationRuntime) {
    return useUserStore.getState().user?.id === context.ownerId
        && context.designProjectIdRef.current === context.projectId && context.runtime.isObservationCurrent();
}

export async function saveCanvasConversationSessions(context: CanvasConversationRuntime, sessions: CanvasAssistantSession[], activeId: string | null, options?: { flush: boolean }) {
    const serverPointer = Boolean(options?.flush && sessions.some(session => session.serverConversationId));
    if (serverPointer && (!context.ownerId || !current(context) || !await context.runtime.waitForWriteAccess() || !current(context))) throw new Error("画布或账号已切换，会话编号尚未保存，未继续发送消息。");
    if (!current(context)) return;
    context.setChatSessions(sessions);
    context.setActiveChatId(activeId);
    if (options?.flush) {
        context.projectSaveQueueRef.current?.flush();
        if (!current(context)) throw new Error("画布或账号已切换，会话编号尚未保存，未继续发送消息。");
        context.updateProject(context.projectId, { chatSessions: sessions, activeChatId: activeId });
        await flushCanvasPersistence();
    }
    if (serverPointer && !current(context)) throw new Error("画布或账号已切换，未继续发送消息。");
}

export async function installCanvasConversationVersion(context: CanvasConversationRuntime, version: PublicImageVersion) {
    const canInstall = () => Boolean(context.ownerId) && current(context) && context.savedProjectIdRef.current === context.projectId;
    if (!canInstall() || !await context.runtime.waitForWriteAccess() || !canInstall()) throw new Error("画布或账号已切换，未安装图片结果。");
    const bounds = context.containerRef.current?.getBoundingClientRect();
    const center = context.screenToCanvas((bounds?.left || 0) + context.size.width / 2, (bounds?.top || 0) + context.size.height / 2);
    const next = projectCanvasImageConversationVersion(context.nodesRef.current, version, center);
    if (next !== context.nodesRef.current) context.setNodes(context.nodesRef.current = next);
    context.projectSaveQueueRef.current?.flush();
    if (!canInstall()) throw new Error("画布写入权限已变化，图片仍保存在服务端会话中。");
    context.updateProject(context.projectId, { nodes: context.nodesRef.current });
    await flushCanvasPersistence();
    if (!canInstall()) throw new Error("画布或账号已切换，已停止继续安装图片。");
}
