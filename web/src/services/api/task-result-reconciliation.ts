import { watchTaskEvents } from "./task-events";

export type TaskRecoveryKind = "observe" | "resume" | "investigate" | "terminal";

/** A local observation stop is not a server pause or an unknown paid submission. */
export function classifyTaskRecovery(task?: { status: string; upstreamTaskId?: string | null }): TaskRecoveryKind {
    if (task?.status === "paused") return task.upstreamTaskId?.trim() ? "resume" : "investigate";
    if (!task || ["waiting", "processing"].includes(task.status)) return "observe";
    return ["success", "failed", "cancelled"].includes(task.status) ? "terminal" : "investigate";
}

export const submissionInvestigationMessage = "提交结果待核查，暂无法恢复上游查询。请联系管理员核对原任务；刷新状态不会重新生成，请勿重复提交。";

/**
 * A view-scoped, read-only reconciler. One callback runs at a time; it shares
 * the existing SSE connection and also resnapshots on focus/online or a slow
 * bounded fallback, including a healthy connection that missed a notification.
 * The caller owns cleanup and must never submit/recover in this callback.
 */
export async function watchTaskReconciliation(options: {
    taskIds: string[];
    signal: AbortSignal;
    reconcile: () => Promise<void>;
    foregroundOnly?: boolean;
    intervalMs?: number;
    onError?: (error: unknown) => void;
    watch?: typeof watchTaskEvents;
    wakeTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
    visibility?: Pick<Document, "hidden">;
}) {
    const foregroundOnly = options.foregroundOnly !== false;
    const events = (options.watch || watchTaskEvents)(options.taskIds, { background: !foregroundOnly });
    const target = options.wakeTarget || (typeof window !== "undefined" ? window : undefined);
    const visibility = options.visibility || (typeof document !== "undefined" ? document : undefined);
    const interval = options.intervalMs ?? 30_000;
    try {
        for (;;) {
            options.signal.throwIfAborted();
            // Capture before GET so an event arriving during it is not lost.
            const revision = events.version;
            if (!foregroundOnly || !visibility?.hidden) {
                try { await options.reconcile(); }
                catch (error) { options.signal.throwIfAborted(); options.onError?.(error); }
            }
            options.signal.throwIfAborted();
            const wake = new AbortController();
            const onWake = () => wake.abort();
            target?.addEventListener("focus", onWake);
            target?.addEventListener("online", onWake);
            try {
                await events.next(revision, interval, AbortSignal.any([options.signal, wake.signal]), interval);
            } catch (error) {
                options.signal.throwIfAborted();
                if (!wake.signal.aborted) throw error;
            } finally {
                target?.removeEventListener("focus", onWake);
                target?.removeEventListener("online", onWake);
            }
        }
    } finally { events.close(); }
}
