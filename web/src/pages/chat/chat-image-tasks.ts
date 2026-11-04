import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";
import type { ChatGeneratedImage, ChatSession } from "./chat-types";

export function chatImageTaskSignature(task: Pick<PendingChatImageTask, "prompt" | "modelId" | "quality" | "resolution" | "size" | "action" | "parentId" | "referenceImageIds" | "maskAdaptation" | "regionComposite">) {
    return JSON.stringify([task.action, task.prompt.trim(), task.modelId, task.quality || "", task.resolution || "", task.size || "", task.parentId || "", task.referenceImageIds || [],
        task.regionComposite ? [task.regionComposite.mode, task.regionComposite.source, task.regionComposite.selection] : task.maskAdaptation?.maskStorageKey || ""]);
}

/** An old uncertain request may be queried, never replayed by a fresh send. */
export function duplicateChatImageTask(session: ChatSession, task: PendingChatImageTask) {
    const signature = task.signature || chatImageTaskSignature(task);
    return session.messages.find(item => item.pendingImageTask && (item.pendingImageTask.signature || chatImageTaskSignature(item.pendingImageTask)) === signature);
}

/** Complete the exact original slot, without stealing a newer user-selected focus. */
export function completeChatImageTask(session: ChatSession, messageId: string, pending: PendingChatImageTask, images: ChatGeneratedImage[], recovered = false): ChatSession {
    if (!images.length || !session.messages.some(item => item.id === messageId && item.pendingImageTask?.requestId === pending.requestId)) return session;
    const shouldFocus = (session.focusRevision || 0) === (pending.focusRevision || 0);
    const workId = pending.workId || images[0]!.id;
    const results = images.map(image => ({ ...image, ...(pending.size ? { size: pending.size } : {}), parentId: pending.parentId, workId, workNote: pending.workNote }));
    return {
        ...session,
        ...(shouldFocus ? { focusImageId: results[0]!.id, editTargetImageId: results[0]!.id, focusLocked: false, newCreation: false, focusRevision: (session.focusRevision || 0) + 1 } : {}),
        messages: session.messages.map(item => {
            if (item.id !== messageId || item.pendingImageTask?.requestId !== pending.requestId) return item;
            const { pendingImageTask: _pending, stopped: _stopped, ...saved } = item;
            return { ...saved, role: "assistant", content: [pending.explanation, recovered ? "已找回原任务结果，本次没有重新生成。" : ""].filter(Boolean).join("\n\n"), generatedImages: results };
        }),
        updatedAt: new Date().toISOString(),
    };
}
