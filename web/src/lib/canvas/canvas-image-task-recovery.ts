import type { QueuedTask } from "@/services/api/generation-tasks";

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
    const { signal, isCurrent, getTask, getByRequestId, onTask, wait = waitForNextQuery } = options;
    let taskId = binding.taskId;
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

    for (;;) {
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
        await guarded(() => wait(signal));
        assertCurrent();
    }
}

function waitForNextQuery(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(abortError()); return; }
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, 1_000);
        signal.addEventListener("abort", abort, { once: true });
    });
}
