import type { QueuedTask } from "@/services/api/generation-tasks";

/** Mirrors the existing server cancellation boundary; unknown fields are not permission. */
export function canCancelQueuedTask(task: QueuedTask | null | undefined): boolean {
    return Boolean(task && ["waiting", "paused"].includes(task.status) && task.upstreamTaskId === null && task.submissionStartedAt === null
        && (task.operationType === "video_generation" || task.attempts === 0));
}

export async function cancelOriginalTask(id: string, dependencies: {
    read: (id: string) => Promise<QueuedTask | null>;
    cancel: (id: string) => Promise<unknown>;
    assertCurrent: () => void;
}): Promise<QueuedTask> {
    dependencies.assertCurrent();
    const before = await dependencies.read(id);
    dependencies.assertCurrent();
    if (!before || before.id !== id) throw new Error("原任务不存在或无权访问，未发送取消请求。");
    if (!canCancelQueuedTask(before)) return before;
    let cancellationError: unknown;
    try { await dependencies.cancel(id); }
    catch (error) { cancellationError = error; }
    // A lost response is not a rejection. Query once; never resend the cancellation POST.
    dependencies.assertCurrent();
    let after: QueuedTask | null;
    try { after = await dependencies.read(id); }
    catch (error) { throw new Error("取消结果尚未确认，请查询原任务；未重复发送取消请求。", { cause: cancellationError || error }); }
    dependencies.assertCurrent();
    if (!after || after.id !== id) throw new Error("取消结果尚未确认，请查询原任务；未重复发送取消请求。", { cause: cancellationError });
    return after;
}
