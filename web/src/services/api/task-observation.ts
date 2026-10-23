/** Observation limits never change the server task or imply a provider failure. */
export class TaskObservationStoppedError extends Error {
    constructor(readonly reason: "timeout" | "unavailable", readonly taskIds: string[] = []) {
        super(reason === "timeout" ? "本次查询已达到观察期限，任务可能仍在处理。可继续查询原任务，不会重新生成。" : "暂时无法查询原任务，请稍后继续查询；不会重新生成。");
        this.name = "TaskObservationStoppedError";
    }
}

export function observationDelay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(done, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("已停止查询，未取消服务端任务", "AbortError")); };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

export async function observeTask<T>(options: {
    read: (signal: AbortSignal) => Promise<T>;
    done: (value: T) => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
    taskIds?: string[];
    now?: () => number;
    delay?: typeof observationDelay;
    ready?: (remainingMs: number, signal?: AbortSignal) => Promise<void>;
    waitForChange?: (remainingMs: number, signal?: AbortSignal) => Promise<void>;
}) {
    const now = options.now || Date.now;
    const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
    let failures = 0;
    for (;;) {
        options.signal?.throwIfAborted();
        await options.ready?.(Math.max(0, deadline - now()), options.signal);
        const remaining = deadline - now();
        if (remaining <= 0) throw new TaskObservationStoppedError("timeout", options.taskIds);
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(20_000, remaining)));
        const querySignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        let value: T;
        try { value = await options.read(querySignal); failures = 0; }
        catch (error) {
            options.signal?.throwIfAborted();
            if (++failures >= 3) throw new TaskObservationStoppedError("unavailable", options.taskIds);
            await (options.delay || observationDelay)(Math.min(1_000 * 2 ** failures, Math.max(0, deadline - now())), options.signal);
            continue;
        }
        if (options.done(value)) return value;
        if (options.waitForChange) await options.waitForChange(Math.max(0, deadline - now()), options.signal);
        else await (options.delay || observationDelay)(Math.min(options.intervalMs ?? 2_500, Math.max(0, deadline - now())), options.signal);
    }
}
