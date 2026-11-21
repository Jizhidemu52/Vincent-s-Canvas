export type TaskPausedKind = "result_repair" | "awaiting_query" | "submission_unknown" | "needs_review";
export type TaskRepairState = { status?: unknown; pausedKind?: unknown; repairErrorCode?: unknown; repairAttempts?: unknown };

export function taskRepairMessage(task: TaskRepairState) {
    if (!["paused", "waiting", "processing"].includes(String(task.status))) return;
    switch (task.pausedKind) {
        case "result_repair": return Number.isInteger(task.repairAttempts) && Number(task.repairAttempts) > 0
            ? `已生成，正在第 ${task.repairAttempts} 次恢复保存原结果，不会重新扣费。`
            : "已生成，正在安排重新保存原结果，不会重新扣费。";
        case "awaiting_query": return "正在查询原任务，不会重新生成。";
        case "submission_unknown": return "提交结果待核查，请联系管理员；不会自动重发。";
        case "needs_review": {
            const reason = reviewReasons.get(String(task.repairErrorCode));
            return reason ? `已出图，但${reason}；不会自动重新生成。如需核查，请联系管理员。` : "原任务需管理员处理，请核查结果及已有素材；不会自动重新生成。";
        }
    }
}

const reviewReasons = new Map([
    ["IMAGE_RESULT_DIMENSION_MISMATCH", "结果与原件的尺寸或宽高比不一致"],
    ["INVALID_IMAGE_RESULT_INPUT", "结果格式、尺寸或蒙版未通过校验"],
    ["RESULT_OUTPUT_INVALID", "输出文件未通过校验"],
    ["RESULT_MASK_INVALID", "前景蒙版无效"],
    ["IMAGE_RESULT_TRANSPARENCY_MISSING", "未得到要求的透明背景"],
    ["IMAGE_RESULT_RECIPE_RETIRED", "该蒙版处理方式已停用"],
]);

export function repairDiagnosticMessage(code?: string) {
    if (!code) return;
    const reason = reviewReasons.get(code);
    if (reason) return `已出图，但${reason}；请核查原件，不要重复生成。`;
    switch (code) {
        case "SUBMISSION_UNKNOWN": case "UPSTREAM_OUTCOME_UNKNOWN": case "PROMPT_SUBMISSION_UNCERTAIN":
            return "提交结果待核查，请联系管理员；不会自动重新生成。";
        case "UPSTREAM_QUERY_PENDING": return "正在查询原任务，不会重新生成。";
        case "STORAGE_ENOSPC": return "已出图，但保存空间不足；请查询原任务的保存进度，不要重复生成。";
        case "STORAGE_LENGTH_MISMATCH": return "原结果保存长度不一致，请查询原任务的保存进度。";
        case "IMAGE_RESULT_PROCESSING_TIMEOUT": case "RESULT_DOWNLOAD_FAILED": case "RESULT_STORAGE_FAILED": case "LAYER_PARTIAL_SAVE":
            return "原结果尚未保存完整，请查询原任务，不要重复生成。";
    }
}

export function isReviewValidationFailure(code: unknown) {
    return reviewReasons.has(String(code));
}
