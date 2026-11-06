import type { ChatMessage, ChatSession } from "./chat-types";

export function chatSourceTurn(session: ChatSession, messageId: string): ChatMessage | undefined {
    const index = session.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return;
    const selected = session.messages[index]!;
    if (selected.role === "user") return selected;
    if (selected.parentMessageId) return session.messages.slice(0, index).find((item) => item.id === selected.parentMessageId && item.role === "user");
    return session.messages.slice(0, index).findLast((item) => item.role === "user");
}

/** A user-requested branch never overwrites its source or includes later turns. */
export function createChatBranch(session: ChatSession, messageId: string, id: string, now: string) {
    const source = chatSourceTurn(session, messageId);
    if (!source) throw new Error("找不到原始消息，无法重新发送");
    if (session.messages.some(item => item.pendingImageTask?.parentMessageId === source.id || item.id === messageId && item.pendingImageTask)) throw new Error("这条消息的原图片任务尚未核实，请先查询原任务；可以继续发送新的消息。");
    const index = session.messages.indexOf(source);
    const nextUser = session.messages.findIndex((item, itemIndex) => itemIndex > index && item.role === "user");
    const replies = session.messages.slice(index + 1, nextUser < 0 ? undefined : nextUser);
    if (!source.regionSelection && replies.some(item => item.generatedImages?.some(image => image.regionComposite))) throw new Error("这条局部修改没有可重放的选区记录，未重新调用模型。请取消编辑，选择原底图并重新圈选后发送。");
    if (source.regionSelection && (!source.regionSelection.imageId || !source.regionSelection.selection?.storageKey || !source.regionSelection.mask?.storageKey)) throw new Error("原局部选区记录不完整，未重新调用模型。请取消编辑，选择原底图并重新圈选后发送。");
    const { canvasProjectId: _canvas, ...original } = session;
    return {
        source,
        session: {
            ...original, id, title: `${session.title || "对话"} · 分支`, updatedAt: now,
            messages: session.messages.slice(0, index), editTargetImageId: source.editTargetImageId,
            focusImageId: source.focusImageId || source.editTargetImageId, focusLocked: source.focusLocked,
            newCreation: source.newCreation, focusRevision: 0,
            documents: session.documents?.filter(document => source.documentIds?.includes(document.id)), requirementCard: source.requirementCard,
            branchOf: { sessionId: session.id, messageId: source.id },
        } satisfies ChatSession,
    };
}
