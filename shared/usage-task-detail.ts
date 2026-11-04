export const USAGE_TASK_PARAMETER_LABELS = {
    size: "尺寸",
    resolution: "分辨率",
    quality: "质量档位",
    aspectRatio: "比例",
    n: "请求张数",
    seed: "随机种子",
    steps: "步数",
    guidance_scale: "引导系数",
    duration: "请求时长",
    durationSeconds: "请求秒数",
    referenceCount: "声明参考数量",
} as const;
export type UsageTaskParameter = keyof typeof USAGE_TASK_PARAMETER_LABELS;
export const USAGE_TASK_EVIDENCE_LABELS = {
    "asset.candidate_added": "候选",
    "asset.project_added": "进入项目",
    "asset.edited": "编辑",
    "asset.reused": "复用",
    "asset.downloaded": "下载回执",
    "asset.exported": "导出回执",
    "asset.adopted": "正式采纳",
    "asset.delivered": "正式交付",
    "asset.pending": "待定",
    "asset.rejected": "未选用",
} as const;
export type UsageTaskEvidenceType = keyof typeof USAGE_TASK_EVIDENCE_LABELS;
export type UsageTaskResult = {
    position: number;
    assetId: string | null;
    kind: "image" | "video" | null;
    thumbnailAvailable: boolean;
    previewAvailable: boolean;
    evidence: Array<{
        eventType: UsageTaskEvidenceType;
        count: number;
        lastAt: string;
        basis: "client_reported" | "server_confirmed";
    }>;
};
export type UsageTaskDetail = {
    userId: string;
    taskId: string;
    asOf: string;
    status: string;
    operationType: string;
    boardKey: string | null;
    modelName: string | null;
    queuedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    timing: { waitMs: number | null; runMs: number | null; totalMs: number | null };
    bookedCny: string | null;
    parameters: Partial<Record<UsageTaskParameter, string | number>>;
    submittedReferenceCount: number | null;
    results: {
        items: UsageTaskResult[];
        pagination: { page: number; pageSize: number; total: number };
        available: boolean;
    };
};
export type UsageTaskPrompt = {
    userId: string;
    taskId: string;
    prompt: string;
    userInput: string | null;
    promptLength: number;
    userInputLength: number | null;
    truncated: boolean;
};
export function usageTaskDetailPath(userId: string, taskId: string) {
    return `/api/admin/usage/people/${encodeURIComponent(userId)}/tasks/${encodeURIComponent(taskId)}`;
}
export function usageTaskThumbnailPath(userId: string, taskId: string, assetId: string, width: 256 | 1024) {
    return `/api/assets/${encodeURIComponent(assetId)}/thumb?w=${width}&pending=1&usageUserId=${encodeURIComponent(userId)}&usageTaskId=${encodeURIComponent(taskId)}`;
}
