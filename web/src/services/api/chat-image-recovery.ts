import { getQueuedTask, getQueuedTaskByRequestId, recoverQueuedTask, type QueuedTask } from "@/services/api/generation-tasks";
import { classifyTaskRecovery } from "@/services/api/task-result-reconciliation";
import type { CreativeImageLineage } from "@/lib/creative-chat";
import type { ImageAgentWorkNote } from "@/lib/image-agent/work-note";
import type { CanvasMaskAdaptation } from "@/lib/canvas/canvas-mask-adaptation";
import type { ChatRegionComposite } from "@/lib/image-agent/mask";

export type ChatImageRecoveryMode = "observe" | "resume" | "investigate";

export type PendingChatImageTask = {
    requestId: string;
    prompt: string;
    modelId: string;
    quality?: string;
    resolution?: string;
    size?: string;
    action: "generate" | "edit";
    taskId?: string;
    parentMessageId?: string;
    lineage?: CreativeImageLineage;
    parentId?: string;
    workId?: string;
    workNote?: ImageAgentWorkNote;
    spec?: import("../../../../shared/image-agent-iteration").ImageAgentEditSpec;
    referenceImageIds?: string[];
    focusRevision?: number;
    signature?: string;
    requirements?: import("../../../../shared/image-agent-documents").DesignRequirements;
    maskAdaptation?: CanvasMaskAdaptation;
    regionComposite?: ChatRegionComposite;
    explanation?: string;
    recovery?: ChatImageRecoveryMode;
    taskStatus?: string;
    upstreamTaskId?: string | null;
    taskFailureReason?: string | null;
};

export type ChatImageRecoveryResult =
    | { kind: "success"; task: QueuedTask; resultUrls: string[] }
    | { kind: "failed"; task: QueuedTask; content: string }
    | { kind: "needs_attention"; task?: QueuedTask; recovery: ChatImageRecoveryMode; content: string };

/** Read-only by default; an explicit user action may resume polling the verified original task once. */
export async function recoverChatImageTask(
    pending: PendingChatImageTask,
    options: { signal?: AbortSignal; resumePaused?: boolean; snapshotOnly?: boolean; onTask?: (task: QueuedTask) => void | Promise<void> } = {},
): Promise<ChatImageRecoveryResult> {
    const { onTask } = options;
    const signal = options.snapshotOnly
        ? AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(10_000)])
        : options.signal;
    let resumePaused = options.resumePaused === true;
    signal?.throwIfAborted();
    const requestId = `${pending.requestId}:0`;
    let task = pending.taskId
        ? await getQueuedTask(pending.taskId, signal)
        : await getQueuedTaskByRequestId(requestId, signal);
    const taskId = pending.taskId || task?.id;
    let previousStatus: string | undefined;

    for (;;) {
        signal?.throwIfAborted();
        if (!task) {
            return {
                kind: "needs_attention",
                recovery: "investigate",
                content: `未找到原图片任务（${taskId ? `任务 ${taskId}` : `请求 ${pending.requestId}`}）。提交状态待核查，请复制诊断信息交由管理员核查，请勿重复生成。`,
            };
        }
        if (task.id !== taskId || task.requestId !== requestId) {
            return {
                kind: "needs_attention",
                recovery: "investigate",
                content: `原图片任务标识不匹配（任务 ${taskId}）。提交状态待核查，请复制诊断信息交由管理员核查，请勿重复生成。`,
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
                    recovery: "investigate",
                    content: `原图片任务已完成但没有可用图片（任务 ${task.id}）。结果待核查，请复制诊断信息交由管理员核查，请勿重复生成。`,
                };
            }
            case "failed":
            case "cancelled":
                return { kind: "failed", task, content: task.failureReason || (task.status === "cancelled" ? "原图片任务已取消" : "原图片任务生成失败") };
            case "paused":
                if (resumePaused && classifyTaskRecovery(task) === "resume") {
                    resumePaused = false;
                    task = await recoverQueuedTask(task.id, signal);
                    continue;
                }
                return {
                    kind: "needs_attention",
                    task,
                    recovery: classifyTaskRecovery(task) === "resume" ? "resume" : "investigate",
                    content: classifyTaskRecovery(task) === "resume"
                        ? `原图片任务的上游查询已暂停（任务 ${task.id}）。可点击“恢复原任务查询”恢复已有任务的轮询，请勿重复生成。`
                        : `提交结果待核查，暂无法恢复上游查询（任务 ${task.id}）。缺少上游任务 ID；刷新状态仅核对服务端记录，请复制诊断信息交由管理员或供应商核查，请勿重复生成。`,
                };
            case "waiting":
            case "processing":
                if (options.snapshotOnly) return {
                    kind: "needs_attention",
                    task,
                    recovery: "observe",
                    content: `原图片任务仍在处理中（任务 ${task.id}）。本页将自动核对结果，也可刷新状态；只查询原记录，不会重新提交。`,
                };
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
                    recovery: "investigate",
                    content: `原图片任务状态未知（任务 ${task.id}）。提交状态待核查，请复制诊断信息交由管理员核查，请勿重复生成。`,
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
