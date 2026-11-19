import { designExecutionHistoryRecordSchema, type DesignExecutionHistoryRecord } from "../../../../../shared/design-conversation-history";
import { projectDesignConversationTurn, type DesignConversationTask, type DesignReferenceAsset } from "./conversation-execution";

export function restoreServerDesignExecution(value: DesignExecutionHistoryRecord, ownerId: string, canvasExternalId: string): DesignConversationTask {
    const record = designExecutionHistoryRecordSchema.parse(value);
    if (record.canvasExternalId !== canvasExternalId) throw new Error("设计执行记录不属于当前画布。");
    const assets = new Map<string, DesignReferenceAsset>();
    const add = (assetId: string, role: string) => {
        if (!assets.has(assetId)) assets.set(assetId, { id: assetId, assetId, title: role === "base" ? "原修改对象" : `原参考图 ${assets.size + 1}`,
            image: `/api/assets/${assetId}/content`, role, kind: "reference" });
    };
    if (record.initialAssetId) add(record.initialAssetId, "base");
    for (const attachment of record.turnRequest?.attachments || []) add(attachment.assetId, attachment.purpose === "auto" ? "auto" : "reference");
    const task: DesignConversationTask = {
        kind: "image-conversation-execution", id: record.id, requestId: record.id, ownerId, projectId: canvasExternalId,
        generationAllowed: false, serverHistory: true, mediaKind: "image", model: "自动图片服务", modelId: "",
        prompt: record.turnRequest?.text || "", references: [...assets.values()], proposal: { id: record.id, batchId: record.conversationId, title: record.title || "已保存的设计执行记录" },
        status: "paused", startedAt: Date.parse(record.createdAt), observing: Boolean(record.turn), resultUrls: [], resultVersions: [],
        failureReason: "会话已保存，但尚未提交图片请求；本页不会自动继续未提交的生成。", queryError: "", persistenceError: "",
        feedback: { status: "unreviewed", note: "" }, feedbackHistory: [],
        conversationExecution: { schemaVersion: 1, phase: "failed", fingerprint: "", assets: [...assets.values()], createRequest: null,
            createDispatchStartedAt: record.createdAt, conversationId: record.conversationId, turnRequest: record.turnRequest,
            turnDispatchStartedAt: record.turn?.createdAt || null, turnId: record.turn?.id || null, latestEventSeq: 0 },
    };
    return record.turn ? projectDesignConversationTurn(task, record.turn, record.outputVersion ? [record.outputVersion] : []) : task;
}
