export type CanvasTimeoutScheduler = {
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (handle: unknown) => void;
};

const browserScheduler: CanvasTimeoutScheduler = {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** Owns short-lived UI callbacks so stale transitions cannot update a replaced canvas. */
export function createCanvasTimeoutRegistry(scheduler: CanvasTimeoutScheduler = browserScheduler) {
    const timers = new Map<string, unknown>();

    const clear = (key: string) => {
        const handle = timers.get(key);
        if (handle === undefined) return;
        scheduler.clearTimeout(handle);
        timers.delete(key);
    };

    return {
        schedule(key: string, callback: () => void, delayMs: number) {
            clear(key);
            let handle: unknown;
            handle = scheduler.setTimeout(() => {
                if (timers.get(key) !== handle) return;
                timers.delete(key);
                callback();
            }, delayMs);
            timers.set(key, handle);
        },
        clear,
        clearAll() {
            timers.forEach((handle) => scheduler.clearTimeout(handle));
            timers.clear();
        },
    };
}
