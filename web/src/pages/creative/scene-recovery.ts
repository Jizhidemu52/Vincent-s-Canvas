import { getQueuedTask, getQueuedTaskByRequestId, type QueuedTask } from "@/services/api/generation-tasks";
import { getPromptCompilation, type PublicPromptCompilation } from "@/services/api/prompt-compilations";
import type { SceneForm } from "./scene-form-model";
import type { SceneImages, SceneLog, SceneParameters, SceneResult, SceneSelection } from "./use-scene-workspace";

export const canQuerySceneResult = (result: SceneResult) => Boolean((result.requestId || result.taskId) && (result.status === "pending" || result.failureKind === "uncertain"));
export const sceneTaskRequestId = (result: SceneResult) => result.requestId?.endsWith(":0") ? result.requestId : result.requestId ? `${result.requestId}:0` : undefined;
export const sceneRootRequestId = (result: SceneResult) => sceneTaskRequestId(result)?.replace(/:0$/, "");

export function sceneInputMatchesLog(log: SceneLog, form: SceneForm, images: SceneImages, config: SceneParameters, selection: SceneSelection | null) {
    return JSON.stringify(log.form) === JSON.stringify(form)
        && ["model", "imageModel", "size", "quality", "imageOptions"].every(key => (log.config[key as keyof SceneParameters] || "") === (config[key as keyof SceneParameters] || ""))
        && ["primary", "secondary"].every(key => log.referenceImages[key as keyof SceneImages]?.id === images[key as keyof SceneImages]?.id)
        && (log.selection?.mask.id || "") === (selection?.mask.id || "");
}

/** GET-only reconciliation. In particular, a missing task is not permission to generate. */
export async function readSceneRequest(log: SceneLog, result: SceneResult, ownerId: string, deps = { getQueuedTask, getQueuedTaskByRequestId, getPromptCompilation }): Promise<{ task: QueuedTask | null; compilation: PublicPromptCompilation | null }> {
    if (log.ownerId !== ownerId || !log.results.some(item => item.id === result.id && item.requestId === result.requestId) || !canQuerySceneResult(result)) throw new Error("原请求不属于当前账号或记录，未查询或提交");
    const requestId = sceneTaskRequestId(result);
    const [task, compilation] = await Promise.all([
        result.taskId ? deps.getQueuedTask(result.taskId) : requestId ? deps.getQueuedTaskByRequestId(requestId) : Promise.resolve(null),
        requestId ? deps.getPromptCompilation(requestId) : Promise.resolve(null),
    ]);
    if (task && ((task.userId && task.userId !== ownerId) || (task.ownerUserId && task.ownerUserId !== ownerId) || (requestId && task.requestId !== requestId))) throw new Error("原任务身份不匹配，未恢复结果");
    return { task, compilation };
}
