import {
    USAGE_TASK_EVIDENCE_LABELS,
    USAGE_TASK_PARAMETER_LABELS,
    usageTaskDetailPath,
    usageTaskThumbnailPath,
    type UsageTaskDetail,
    type UsageTaskPrompt,
} from "../../../../shared/usage-task-detail";
import { UsageAnalyticsError } from "./usage-analytics";
export * from "../../../../shared/usage-task-detail";

const uuid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, any> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, allowed: string[]) =>
    record(value) && Object.keys(value).every((key) => allowed.includes(key));
const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown) => value === null || (typeof value === "string" && value.length <= 300);
function identities(userId: string, taskId: string) {
    if (!uuid(userId) || !uuid(taskId))
        throw new UsageAnalyticsError("当前记录缺少有效员工或任务身份，未读取。", "INVALID_TASK_IDENTITY");
}
function fail(status: number) {
    throw new UsageAnalyticsError(
        status === 404
            ? "任务或图片不存在或无权访问，未加载原始内容。"
            : status === 401 || status === 403
              ? "当前登录无权查看任务详情。"
              : "任务读取未完成，请手动重试；不会自动读取原图或提示词。",
        "USAGE_TASK_REQUEST_FAILED",
        status,
    );
}
function safeFailure(error: unknown): never {
    if (error instanceof UsageAnalyticsError || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new UsageAnalyticsError("任务读取连接或格式异常，未自动重试。", "USAGE_TASK_RESPONSE_FAILED");
}
async function request(path: string, signal?: AbortSignal, body?: { confirm: true }) {
    try {
        const response = await fetch(path, {
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal,
            ...(body
                ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
                : {}),
        });
        if (!response.ok) fail(response.status);
        const envelope = await response.json();
        signal?.throwIfAborted();
        if (envelope?.code !== 0 || !record(envelope.data))
            throw new UsageAnalyticsError("任务详情响应不完整。", "INVALID_TASK_DETAIL");
        return envelope.data;
    } catch (error) {
        safeFailure(error);
    }
}
export async function getUsageTaskDetail(
    userId: string,
    taskId: string,
    page = 1,
    signal?: AbortSignal,
): Promise<UsageTaskDetail> {
    identities(userId, taskId);
    if (!integer(page) || page < 1 || page > 10000)
        throw new UsageAnalyticsError("结果页码无效。", "INVALID_TASK_PAGE");
    const value = await request(`${usageTaskDetailPath(userId, taskId)}?page=${page}&pageSize=12`, signal);
    const valid =
        keys(value, [
            "userId",
            "taskId",
            "asOf",
            "status",
            "operationType",
            "boardKey",
            "modelName",
            "queuedAt",
            "startedAt",
            "completedAt",
            "timing",
            "bookedCny",
            "parameters",
            "submittedReferenceCount",
            "results",
        ]) &&
        value.userId === userId &&
        value.taskId === taskId &&
        time(value.asOf) &&
        time(value.queuedAt) &&
        (value.startedAt === null || time(value.startedAt)) &&
        (value.completedAt === null || time(value.completedAt)) &&
        typeof value.status === "string" &&
        value.status.length <= 40 &&
        typeof value.operationType === "string" &&
        value.operationType.length <= 80 &&
        nullableText(value.boardKey) &&
        nullableText(value.modelName) &&
        keys(value.timing, ["waitMs", "runMs", "totalMs"]) &&
        ["waitMs", "runMs", "totalMs"].every((key) => value.timing[key] === null || integer(value.timing[key])) &&
        (value.bookedCny === null ||
            (typeof value.bookedCny === "string" && /^\d{1,18}(?:\.\d{1,12})?$/.test(value.bookedCny))) &&
        keys(value.parameters, Object.keys(USAGE_TASK_PARAMETER_LABELS)) &&
        Object.values(value.parameters).every((item) =>
            typeof item === "number" ? Number.isFinite(item) : typeof item === "string" && item.length <= 80,
        ) &&
        (value.submittedReferenceCount === null || integer(value.submittedReferenceCount)) &&
        keys(value.results, ["items", "pagination", "available"]) &&
        typeof value.results.available === "boolean" &&
        keys(value.results.pagination, ["page", "pageSize", "total"]) &&
        value.results.pagination.page === page &&
        value.results.pagination.pageSize === 12 &&
        integer(value.results.pagination.total) &&
        Array.isArray(value.results.items) &&
        value.results.items.length <= 12 &&
        value.results.items.every(
            (item: any, index: number) =>
                keys(item, ["position", "assetId", "kind", "thumbnailAvailable", "previewAvailable", "evidence"]) &&
                item.position === (page - 1) * 12 + index + 1 &&
                item.position <= value.results.pagination.total &&
                (item.assetId === null || uuid(item.assetId)) &&
                ["image", "video", null].includes(item.kind) &&
                typeof item.thumbnailAvailable === "boolean" &&
                typeof item.previewAvailable === "boolean" &&
                (item.assetId !== null || (item.kind === null && !item.thumbnailAvailable && !item.previewAvailable)) &&
                Array.isArray(item.evidence) &&
                item.evidence.length <= Object.keys(USAGE_TASK_EVIDENCE_LABELS).length &&
                (item.assetId !== null || item.evidence.length === 0) &&
                item.evidence.every(
                    (event: any) =>
                        keys(event, ["eventType", "count", "lastAt", "basis"]) &&
                        Object.hasOwn(USAGE_TASK_EVIDENCE_LABELS, event.eventType) &&
                        integer(event.count) &&
                        event.count > 0 &&
                        time(event.lastAt) &&
                        event.basis ===
                            (["asset.downloaded", "asset.exported"].includes(event.eventType)
                                ? "client_reported"
                                : "server_confirmed"),
                ),
        );
    if (!valid)
        throw new UsageAnalyticsError("任务详情响应与当前人员、任务或页码不一致，未显示。", "INVALID_TASK_DETAIL");
    return value as UsageTaskDetail;
}
export async function getUsageTaskPrompt(
    userId: string,
    taskId: string,
    signal?: AbortSignal,
): Promise<UsageTaskPrompt> {
    identities(userId, taskId);
    const value = await request(`${usageTaskDetailPath(userId, taskId)}/prompt`, signal, { confirm: true });
    if (
        !keys(value, ["userId", "taskId", "prompt", "userInput", "promptLength", "userInputLength", "truncated"]) ||
        value.userId !== userId ||
        value.taskId !== taskId ||
        typeof value.prompt !== "string" ||
        value.prompt.length > 64000 ||
        !(value.userInput === null || (typeof value.userInput === "string" && value.userInput.length <= 64000)) ||
        !integer(value.promptLength) ||
        !(value.userInputLength === null || integer(value.userInputLength)) ||
        typeof value.truncated !== "boolean"
    )
        throw new UsageAnalyticsError("提示词响应与当前任务不一致，未显示。", "INVALID_TASK_PROMPT");
    return value as UsageTaskPrompt;
}
export async function getUsageTaskThumbnail(
    userId: string,
    taskId: string,
    assetId: string,
    width: 256 | 1024,
    signal?: AbortSignal,
): Promise<Blob> {
    identities(userId, taskId);
    if (!uuid(assetId) || ![256, 1024].includes(width))
        throw new UsageAnalyticsError("图片身份或预览尺寸无效。", "INVALID_TASK_ASSET");
    try {
        const response = await fetch(usageTaskThumbnailPath(userId, taskId, assetId, width), {
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal,
        });
        if (response.status === 202 || response.status === 422)
            throw new UsageAnalyticsError("缩略图暂不可用；未改取原图，也不会自动重试。", "TASK_THUMBNAIL_UNAVAILABLE");
        if (!response.ok) fail(response.status);
        const mime = response.headers.get("content-type")?.split(";", 1)[0];
        if (!mime || !["image/webp", "image/png", "image/jpeg", "image/gif", "image/avif"].includes(mime))
            throw new UsageAnalyticsError("图片响应格式不符合安全预览要求。", "INVALID_TASK_THUMBNAIL");
        const limit = 8 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > limit)
            throw new UsageAnalyticsError("图片响应超过预览上限。", "INVALID_TASK_THUMBNAIL");
        const reader = response.body?.getReader(),
            chunks: Uint8Array<ArrayBuffer>[] = [];
        if (!reader) throw new UsageAnalyticsError("图片响应为空。", "INVALID_TASK_THUMBNAIL");
        let size = 0;
        try {
            while (true) {
                const part = await reader.read();
                signal?.throwIfAborted();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > limit) throw new UsageAnalyticsError("图片响应超过预览上限。", "INVALID_TASK_THUMBNAIL");
                chunks.push(new Uint8Array(part.value));
            }
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
        if (!size) throw new UsageAnalyticsError("图片响应为空。", "INVALID_TASK_THUMBNAIL");
        return new Blob(chunks, { type: mime });
    } catch (error) {
        safeFailure(error);
    }
}
