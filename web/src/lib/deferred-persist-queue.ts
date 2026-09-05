export type DeferredPersistScheduler = {
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    requestIdle?: (callback: () => void, timeoutMs: number) => unknown;
    cancelIdle?: (handle: unknown) => void;
};

const browserScheduler: DeferredPersistScheduler = {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    ...(typeof window !== "undefined" && "requestIdleCallback" in window
        ? {
            requestIdle: (callback: () => void, timeoutMs: number) => window.requestIdleCallback(callback, { timeout: timeoutMs }),
            cancelIdle: (handle: unknown) => window.cancelIdleCallback(handle as number),
        }
        : {}),
};

/** Defers large persistence serialization until the browser is idle, with a bounded fallback. */
export function createDeferredPersistQueue<T>(delayMs: number, onFlush: (value: T) => void, scheduler: DeferredPersistScheduler = browserScheduler) {
    let timer: unknown | null = null;
    let idle: unknown | null = null;
    let pending: T | undefined;
    let hasPending = false;

    const clearScheduledWork = () => {
        if (timer !== null) {
            scheduler.clearTimeout(timer);
            timer = null;
        }
        if (idle !== null && scheduler.cancelIdle) {
            scheduler.cancelIdle(idle);
            idle = null;
        }
    };

    const clear = () => {
        clearScheduledWork();
        pending = undefined;
        hasPending = false;
    };

    const flush = () => {
        clearScheduledWork();
        if (!hasPending) return;
        const value = pending as T;
        pending = undefined;
        hasPending = false;
        onFlush(value);
    };

    return {
        schedule(value: T) {
            pending = value;
            hasPending = true;
            clearScheduledWork();
            timer = scheduler.setTimeout(() => {
                timer = null;
                if (scheduler.requestIdle) {
                    idle = scheduler.requestIdle(flush, 250);
                    return;
                }
                flush();
            }, delayMs);
        },
        clear,
        flush,
    };
}
