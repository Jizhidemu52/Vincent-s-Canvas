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
    if (session.messages.some((item) => item.pendingImageTask)) throw new Error("原图片任务尚未核实，请先查询原任务");
    const source = chatSourceTurn(session, messageId);
    if (!source) throw new Error("找不到原始消息，无法重新发送");
    const index = session.messages.indexOf(source);
    const { canvasProjectId: _canvas, ...original } = session;
    return {
        source,
        session: {
            ...original, id, title: `${session.title || "对话"} · 分支`, updatedAt: now,
            messages: session.messages.slice(0, index), editTargetImageId: source.editTargetImageId,
            branchOf: { sessionId: session.id, messageId: source.id },
        } satisfies ChatSession,
    };
}
