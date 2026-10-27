import type { QueuedTask } from "@/services/api/generation-tasks";
import { watchTaskEvents } from "@/services/api/task-events";
import { TaskObservationStoppedError } from "@/services/api/task-observation";

export type CanvasImageTaskBinding = {
    requestId: string;
    taskId?: string;
    ownerId: string;
    projectId: string;
    resultIndex: number;
};

export type CanvasImageTaskRecoveryOptions = {
    signal: AbortSignal;
    isCurrent: () => boolean;
    getTask: (id: string, signal: AbortSignal) => Promise<QueuedTask | null>;
    getByRequestId: (requestId: string, signal: AbortSignal) => Promise<QueuedTask | null>;
    onTask: (task: QueuedTask) => void | Promise<void>;
    wait?: (signal: AbortSignal) => Promise<void>;
};

const abortError = () => new DOMException("图片任务恢复已取消", "AbortError");

/** Observe an existing task only. Persist a discovered ID before making another query. */
export async function observeCanvasImageTask(binding: CanvasImageTaskBinding, options: CanvasImageTaskRecoveryOptions): Promise<QueuedTask | null> {
    const { requestId, ownerId } = binding;
    const { signal, isCurrent, getTask, getByRequestId, onTask, wait } = options;
    let taskId = binding.taskId;
    let events = !wait && taskId ? watchTaskEvents([taskId], { background: true }) : undefined;
    const deadline = Date.now() + 15 * 60_000;
    const assertCurrent = () => {
        if (signal.aborted || !isCurrent()) throw abortError();
    };
    const guarded = async <T>(action: () => T | Promise<T>): Promise<T> => {
        assertCurrent();
        let abort: () => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            abort = () => reject(abortError());
            signal.addEventListener("abort", abort, { once: true });
        });
        try {
            const result = await Promise.race([
                Promise.resolve().then(() => { assertCurrent(); return action(); }),
                aborted,
            ]);
            assertCurrent();
            return result;
        } catch (error) {
            assertCurrent();
            throw error;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    };

    try { for (;;) {
        if (events) await guarded(() => events!.ready(Math.max(0, deadline - Date.now()), signal));
        if (Date.now() >= deadline) throw new TaskObservationStoppedError("timeout", taskId ? [taskId] : []);
        const revision = events?.version ?? 0;
        const task = await guarded(() => taskId ? getTask(taskId, signal) : getByRequestId(requestId, signal));
        assertCurrent();
        if (!task) return null;
        if (!task.id || (taskId && task.id !== taskId) || task.requestId !== requestId ||
            [task.ownerUserId, task.userId].some(owner => owner !== undefined && owner !== ownerId)) {
            throw new Error("原图片任务标识或归属不匹配，已停止恢复");
        }
        if (!["waiting", "processing", "success", "failed", "cancelled", "paused"].includes(task.status)) {
            throw new Error(`原图片任务状态未知（${task.status || "空"}），已停止查询，请勿重复生成`);
        }
        await guarded(() => onTask(task));
        assertCurrent();
        taskId = task.id;
        if (task.status !== "waiting" && task.status !== "processing") return task;
        if (!wait && !events) events = watchTaskEvents([taskId], { background: true });
        await guarded(() => wait ? wait(signal) : events!.next(revision, Math.max(0, deadline - Date.now()), signal));
        assertCurrent();
    } } finally { events?.close(); }
}
