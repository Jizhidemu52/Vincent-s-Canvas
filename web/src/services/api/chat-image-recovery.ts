import { getQueuedTask, listQueuedTasks, recoverQueuedTask, type QueuedTask } from "@/services/api/generation-tasks";
import type { CreativeImageLineage } from "@/lib/creative-chat";

export type PendingChatImageTask = {
    requestId: string;
    prompt: string;
    modelId: string;
    quality?: string;
    resolution?: string;
    action: "generate" | "edit";
    taskId?: string;
    parentMessageId?: string;
    lineage?: CreativeImageLineage;
    explanation?: string;
};

export type ChatImageRecoveryResult =
    | { kind: "success"; task: QueuedTask; resultUrls: string[] }
    | { kind: "failed"; task: QueuedTask; content: string }
    | { kind: "needs_attention"; task?: QueuedTask; content: string };

/** Read-only by default; an explicit user action may resume polling the verified original task once. */
export async function recoverChatImageTask(
    pending: PendingChatImageTask,
    options: { signal?: AbortSignal; resumePaused?: boolean; onTask?: (task: QueuedTask) => void | Promise<void> } = {},
): Promise<ChatImageRecoveryResult> {
    const { signal, onTask } = options;
    let resumePaused = options.resumePaused === true;
    signal?.throwIfAborted();
    const requestId = `${pending.requestId}:0`;
    let task = pending.taskId
        ? await getQueuedTask(pending.taskId, signal)
        : (await listQueuedTasks(signal)).find((candidate) => candidate.requestId === requestId);
    const taskId = pending.taskId || task?.id;
    let previousStatus: string | undefined;

    for (;;) {
        signal?.throwIfAborted();
        if (!task) {
            return {
                kind: "needs_attention",
                content: `未找到原图片任务（${taskId ? `任务 ${taskId}` : `请求 ${pending.requestId}`}）。提交状态待核查，请勿重复生成。`,
            };
        }
        if (task.id !== taskId || task.requestId !== requestId) {
            return {
                kind: "needs_attention",
                content: `原图片任务标识不匹配（任务 ${taskId}）。提交状态待核查，请勿重复生成。`,
            };
        }
        if (task.status !== previousStatus) {
            previousStatus = task.status;
            await onTask?.(task);
            signal?.throwIfAborted();
        }

        switch (task.status) {
            case "success": {
                const resultUrls = Array.isArray(task.resultUrls) ? task.resultUrls.filter((url) => typeof url === "string" && url.trim()) : [];
                if (resultUrls.length) return { kind: "success", task, resultUrls };
                return {
                    kind: "needs_attention",
                    task,
                    content: `原图片任务已完成但没有可用图片（任务 ${task.id}）。结果待核查，请勿重复生成。`,
                };
            }
            case "failed":
            case "cancelled":
                return { kind: "failed", task, content: task.failureReason || (task.status === "cancelled" ? "原图片任务已取消" : "原图片任务生成失败") };
            case "paused":
                if (resumePaused && task.upstreamTaskId?.trim()) {
                    resumePaused = false;
                    task = await recoverQueuedTask(task.id, signal);
                    continue;
                }
                return {
                    kind: "needs_attention",
                    task,
                    content: `${task.failureReason || "原图片任务查询已暂停"}（任务 ${task.id}）。提交状态待核查，请勿重复生成。`,
                };
            case "waiting":
            case "processing":
                // An explicit click is not permission to retry a later polling failure.
                resumePaused = false;
                await waitForNextQuery(signal);
                signal?.throwIfAborted();
                task = await getQueuedTask(task.id, signal);
                break;
            default:
                return {
                    kind: "needs_attention",
                    task,
                    content: `原图片任务状态未知（任务 ${task.id}）。提交状态待核查，请勿重复生成。`,
                };
        }
    }
}

function waitForNextQuery(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(signal?.reason || new DOMException("请求已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, 1_000);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
