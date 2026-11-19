import type { ConversationMessage } from "../../../shared/image-conversation-contracts";
import type { PublicConversationSnapshot as ConversationSnapshot, PublicImageTurn as ImageTurn, PublicImageVersion as ImageVersion, PublicSettingsSnapshot as SettingsSnapshot } from "../../../shared/image-conversation-public";

export const conversationIds = {
    owner: "00000000-0000-4000-8000-000000000099", conversation: "81000000-0000-4000-8000-000000000001",
    root: "81000000-0000-4000-8000-000000000002", generated: "81000000-0000-4000-8000-000000000003",
    asset: "81000000-0000-4000-8000-000000000004", resultAsset: "81000000-0000-4000-8000-000000000005",
    turn: "81000000-0000-4000-8000-000000000006", task: "81000000-0000-4000-8000-000000000007", model: "81000000-0000-4000-8000-000000000008",
    message: "81000000-0000-4000-8000-000000000009", reply: "81000000-0000-4000-8000-000000000010",
};
export const conversationTime = "2026-11-19T04:00:00.000Z";
export const conversationSettings = (): SettingsSnapshot => ({
    policyVersion: "image-auto-v1", sourceMap: { model: "admin_binding", quality: "policy", resolution: "policy", complexity: "policy", output_format: "policy", n: "policy" }, requested: { mode: "auto" },
    intent: { purpose: "standard", complexity: "low", sizeMode: "preserve_aspect" }, effective: { modelConfigId: conversationIds.model, model: conversationIds.model, n: 1, quality: "high", resolution: "2k", complexity: "low", output_format: "png" },
    resolutionApplied: true, estimate: { internalCredits: 0, internalRmb: "0", providerEstimatedRmb: null, providerActualRmb: null, priceSource: "fixture", priceVersion: "fixture", reservationQuality: "high" }, actual: null,
});
export const conversationVersion = (generated = false): ImageVersion => ({
    id: generated ? conversationIds.generated : conversationIds.root, conversationId: conversationIds.conversation, rootVersionId: conversationIds.root, parentVersionId: generated ? conversationIds.root : null,
    versionNo: generated ? 2 : 1, imageNo: generated ? 2 : 1, label: generated ? "蓝色版本" : "原图", assetId: generated ? conversationIds.resultAsset : conversationIds.asset,
    source: generated ? "generated" : "upload", turnId: generated ? conversationIds.turn : null, outputIndex: 0, requestedState: { schemaVersion: 1, goals: [], constraints: [] },
    observation: null, acceptance: "unreviewed", parameters: generated ? conversationSettings() : null, actualDimensions: { width: 256, height: 256 }, createdAt: conversationTime,
});
export const conversationTurn = (state: ImageTurn["state"] = "accepted", key = "turn/request-A"): ImageTurn => ({
    id: conversationIds.turn, conversationId: conversationIds.conversation, clientRequestId: key, acceptedRevision: 2, inputActiveVersionId: conversationIds.root, baseVersionId: conversationIds.root,
    outputVersionId: state === "completed" ? conversationIds.generated : null, replyToTurnId: null, intent: "edit", state, plannerStatus: state === "accepted" ? "not_started" : "succeeded", taskId: state === "accepted" ? null : conversationIds.task,
    autoActivate: state !== "detached", settingsSnapshot: null, assistant: { kind: "status", text: "服务端正在处理原请求", canCancel: ["accepted", "planning", "queued", "generating", "uncertain"].includes(state) }, lastError: null, createdAt: conversationTime, updatedAt: conversationTime,
});
export const conversationSnapshot = (): ConversationSnapshot => ({
    id: conversationIds.conversation, title: "针织衫改款", entrypoint: "standalone", projectUuid: null, canvasExternalId: null, activeVersionId: conversationIds.root, stateRevision: 1, createdAt: conversationTime, updatedAt: conversationTime,
    activeVersion: conversationVersion(), pendingTurn: null, latestEventSeq: 1, contextSummary: { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] }, contextSummaryThroughSeq: 0,
});
export const conversationMessage = (assistant = false): ConversationMessage => ({
    id: assistant ? conversationIds.reply : conversationIds.message, conversationId: conversationIds.conversation, turnId: conversationIds.turn, seq: assistant ? 2 : 1,
    role: assistant ? "assistant" : "user", kind: assistant ? "image" : "text", text: assistant ? "图片已保存，请核对实际设计。" : "改为蓝色，保留针织纹理", attachments: assistant ? [conversationIds.generated] : [], createdAt: conversationTime,
});
