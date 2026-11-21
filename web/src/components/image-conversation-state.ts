import { conversationImageLimitError } from "../../../shared/image-agent/focus";
import type {
    AttachmentPurpose,
    ConversationMessage,
    CreateConversationRequest,
    SubmitTurnRequest,
} from "../../../shared/image-conversation-contracts";
import type {
    PublicConversationEvent as ConversationEvent,
    PublicConversationSnapshot as ConversationSnapshot,
    PublicImageTurn as ImageTurn,
    PublicImageVersion as ImageVersion,
} from "../../../shared/image-conversation-public";

export type ConversationView = {
    snapshot: ConversationSnapshot;
    messages: ConversationMessage[];
    versions: ImageVersion[];
    turns: ImageTurn[];
};
export type ConversationAttachment = { assetId: string; name: string; purpose?: AttachmentPurpose };
export type ConversationDraft = { text: string; attachments: ConversationAttachment[] };
export type ConversationLocalState = {
    conversationId: string | null;
    drafts: Record<string, ConversationDraft>;
    receipts: Record<string, SubmitTurnRequest>;
    create: CreateConversationRequest | null;
};
export const emptyConversationDraft = (): ConversationDraft => ({ text: "", attachments: [] });
export const emptyConversationLocalState = (): ConversationLocalState => ({
    conversationId: null,
    drafts: {},
    receipts: {},
    create: null,
});
export const activeTurnStates = new Set(["accepted", "planning", "queued", "generating", "uncertain"]);
const merge = <T extends { id: string }>(items: T[], item: T) => [
    ...items.filter((existing) => existing.id !== item.id),
    item,
];

export function mergeConversationAttachments(current: ConversationAttachment[], incoming: ConversationAttachment[], hasCurrentImage = false) {
    if (new Set(incoming.map((item) => item.assetId)).size !== incoming.length)
        throw new Error("添加的图片重复，请检查图片用途。");
    const bases = incoming.filter((item) => item.purpose === "new_base");
    if (bases.length > 1) throw new Error("每轮只能指定一张修改底图。");
    const result = new Map(
        current.map((item) => [
            item.assetId,
            bases.length && item.purpose === "new_base" && item.assetId !== bases[0].assetId
                ? { ...item, purpose: "reference" as const }
                : item,
        ]),
    );
    for (const item of incoming) result.set(item.assetId, { ...result.get(item.assetId), ...item });
    const limitError = conversationImageLimitError(result.size, hasCurrentImage);
    if (limitError) throw new Error(limitError);
    return [...result.values()];
}

export function conversationRequestAttachments(items: ConversationAttachment[]) {
    return items.map(({ assetId, purpose }) => ({ assetId, purpose: purpose || ("auto" as const) }));
}

export function conversationVersionCanInstall(version: ImageVersion, turn: ImageTurn) {
    return (
        version.source === "generated" &&
        version.turnId === turn.id &&
        version.conversationId === turn.conversationId &&
        turn.state === "completed" &&
        turn.autoActivate &&
        turn.outputVersionId === version.id
    );
}

export function applyConversationEvent(view: ConversationView, event: ConversationEvent): ConversationView {
    if (view.snapshot.id !== event.conversationId || event.seq <= view.snapshot.latestEventSeq) return view;
    const snapshot = {
        ...view.snapshot,
        latestEventSeq: event.seq,
        stateRevision: Math.max(view.snapshot.stateRevision, event.payload.stateRevision),
    };
    const next = { ...view, snapshot };
    if ("turn" in event.payload) {
        const turn = event.payload.turn;
        next.turns = merge(view.turns, turn);
        if (activeTurnStates.has(turn.state)) snapshot.pendingTurn = turn;
        else if (snapshot.pendingTurn?.id === turn.id) snapshot.pendingTurn = null;
    }
    if (event.type === "version.created") {
        next.versions = merge(view.versions, event.payload.version).sort((a, b) => a.imageNo - b.imageNo);
        if (snapshot.activeVersionId === event.payload.version.id) snapshot.activeVersion = event.payload.version;
    }
    if (event.type === "active.changed") {
        snapshot.activeVersionId = event.payload.activeVersionId;
        snapshot.activeVersion = next.versions.find((version) => version.id === event.payload.activeVersionId) || null;
    }
    if (event.type === "message.created")
        next.messages = merge(view.messages, event.payload.message).sort((a, b) => a.seq - b.seq);
    if (event.type === "context_summary.updated") {
        snapshot.contextSummary = event.payload.contextSummary;
        snapshot.contextSummaryThroughSeq = event.payload.contextSummaryThroughSeq;
    }
    if (event.type === "settings.resolved")
        next.turns = view.turns.map((turn) =>
            turn.id === event.payload.turnId ? { ...turn, settingsSnapshot: event.payload.settingsSnapshot } : turn,
        );
    return next;
}

export function conversationTurnStatus(turn: ImageTurn) {
    const names = {
        accepted: "已受理，尚未出图",
        planning: "正在理解本轮要求",
        queued: "原图片任务排队中",
        generating: "原图片任务生成中",
        uncertain: "原任务结果未知，请查询，不要重发",
        completed: turn.outputVersionId ? "图片已保存" : "本轮已完成",
        failed: "本轮未完成",
        cancelled: "提交前已取消",
        detached: "已停止采用结果，原任务可能仍在执行",
    };
    return names[turn.state];
}
