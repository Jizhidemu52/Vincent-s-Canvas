import { getQueuedTask, QueuedTaskFailedError, QueuedTaskPausedError, QueuedTaskSubmissionUncertainError, type ImageGenerationModel } from "@/services/api/generation-tasks";
import { restoreGenerationDraft, type GenerationInputArchive } from "@/services/api/generation-history";
import { restoreLocalInput } from "@/services/generation-local-inputs";
import type { SceneLog, SceneResult } from "./use-scene-workspace";

export function sceneFailure(error: unknown, submitted: boolean, taskId?: string, requestId?: string): Pick<SceneResult, "status" | "error" | "failureKind" | "taskId" | "requestId"> {
    const message = error instanceof Error ? error.message : "操作未完成";
    if (error instanceof QueuedTaskFailedError) return { status: "failed", error: message, failureKind: error.task.status === "failed" ? "terminal" : "local", taskId: error.task.id, requestId: error.task.requestId };
    if (error instanceof QueuedTaskPausedError) return { status: "failed", error: message, failureKind: "uncertain", taskId: error.task.id, requestId: error.task.requestId };
    if (error instanceof QueuedTaskSubmissionUncertainError) return { status: "failed", error: message, failureKind: "uncertain", taskId: error.taskId || taskId, requestId: error.requestId };
    return { status: "failed", error: submitted ? `${message}；请查询原任务，勿重复生成。` : message, failureKind: submitted ? "uncertain" : "local", taskId, requestId };
}

export const canRetrySceneResult = (result: SceneResult) => result.status === "failed" && result.failureKind === "terminal" && Boolean(result.taskId) && !result.uncompositedImage && !result.retryLogId;

/** Read and validate every frozen input before permitting one new paid task. */
export async function prepareSceneRetry(log: SceneLog, result: SceneResult, models: ImageGenerationModel[], ownerId: string, deps = { getQueuedTask, restoreGenerationDraft, restoreLocalInput }) {
    if (result.retryLogId) throw new Error("此失败项已发起过重试，请查看对应的新记录");
    if (!canRetrySceneResult(result) || !log.results.some(item => item.id === result.id && item.taskId === result.taskId)) throw new Error("仅可重试服务端已明确失败的单张结果");
    if (log.ownerId !== ownerId || log.inputArchiveVersion !== 1 || log.operation !== "ai") throw new Error("原记录没有完整输入归档，无法重试");
    const task = await deps.getQueuedTask(result.taskId!);
    if (!task || task.status !== "failed" || task.id !== result.taskId || (task.userId && task.userId !== ownerId)) throw new Error("原任务不是明确失败状态，请查询原任务，勿重复生成");
    const archive = task.parameters?.inputArchive as GenerationInputArchive | undefined;
    if (!archive || archive.version !== 1 || archive.ownerId !== ownerId || archive.modelConfigId !== log.config.imageModel || typeof archive.effectivePrompt !== "string") throw new Error("原任务与本地记录不一致，未提交重试");
    const draft = await deps.restoreGenerationDraft(result.taskId!);
    const model = models.find(item => item.id === archive.modelConfigId && item.modelId === archive.modelId);
    if (!model || draft.config.imageModel !== model.id || draft.tool !== `creative-${log.sceneId}` || !["image_generation", "inpaint"].includes(draft.operationType)) throw new Error("原模型或场景配置已变化，未提交重试");
    const referenceImages = Object.fromEntries(await Promise.all(Object.entries(log.referenceImages).map(async ([slot, image]) => [slot, await deps.restoreLocalInput(image!)])));
    const selection = log.selection ? { ...log.selection, mask: await deps.restoreLocalInput(log.selection.mask) } : null;
    if (selection && (!referenceImages.primary || selection.sourceId !== referenceImages.primary.id || selection.mask.width !== referenceImages.primary.width || selection.mask.height !== referenceImages.primary.height)) throw new Error("原选区与参考图不匹配，未提交重试");
    return { referenceImages, selection, input: { modelId: model.modelId, resolvedModel: model, prompt: archive.effectivePrompt, count: 1,
        operationType: draft.operationType as "image_generation" | "inpaint", tool: draft.tool, parameters: draft.parameters,
        draft: { prompt: draft.prompt, config: draft.config, maskReferenceIndex: draft.maskReferenceIndex }, references: draft.references } };
}
