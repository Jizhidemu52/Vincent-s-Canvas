import type { SceneResult } from "./use-scene-workspace";

type Identity = Pick<SceneResult, "id" | "taskId" | "requestId">;
type Observation = Omit<SceneResult, "id">;

export function assertResultConsistent(result: SceneResult) {
    if ((result.status !== "failed" && result.failureKind) ||
        (result.progress && result.status !== "pending") ||
        (result.pausedKind && result.status !== "failed") ||
        (result.compilationId && (result.status !== "failed" || result.failureKind !== "uncertain" || result.taskId)) ||
        (result.recovery && (result.status !== "failed" || result.failureKind !== "uncertain")) ||
        (result.status === "success" && (!result.image || result.error)))
        throw new Error("结果状态不一致，未写入记录");
}

export function sceneObservation({ id, requestId, taskId }: Identity, observation: Observation) {
    const result = { taskId, requestId, ...observation, id, failureKind: observation.failureKind, error: observation.error,
        compilationId: observation.compilationId, recovery: observation.recovery, progress: observation.progress };
    assertResultConsistent(result);
    return result;
}

export function restoreSceneObservation(result: SceneResult): SceneResult {
    if (result.status === "pending") return { ...result, failureKind: undefined, recovery: undefined, pausedKind: undefined, compilationId: undefined };
    if (result.status === "failed" && result.failureKind === "uncertain" && result.error === "正在准备提示词，请稍候。")
        return sceneObservation(result, { status: "failed", failureKind: "uncertain", error: "正在查询原任务，不会重新生成。" });
    return result;
}

export function scenePendingTitle(result: SceneResult) {
    switch (result.progress) {
        case "preparing": return "正在准备提示词";
        case "submitting": return "正在提交图片任务";
        case "saving": return "正在保存原结果";
        case "generating": return "图片生成中";
        case "querying": return "正在查询原任务";
        default: return result.taskId ? "图片生成中" : "正在获取进度";
    }
}

export function sceneFailureTitle(result: SceneResult) {
    if (result.pendingFinalImage) return "最终成果待保存";
    if (result.uncompositedImage) return "合成未完成";
    if (result.compilationId) return "等待继续生成";
    switch (result.pausedKind) {
        case "result_repair": return "正在恢复保存原结果";
        case "awaiting_query": return "正在查询原任务";
        case "submission_unknown": return "提交结果待核查";
        case "needs_review": return "需要管理员协助";
    }
    if (result.recovery === "resume") return "获取结果已暂停";
    if (result.recovery === "investigate") return "需要管理员协助";
    return result.failureKind === "uncertain" ? "暂时无法获取进度" : "生成失败";
}
