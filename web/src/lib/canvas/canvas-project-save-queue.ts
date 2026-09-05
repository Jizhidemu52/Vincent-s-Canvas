export type CanvasProjectSaveScheduler = {
    set: (callback: () => void, delayMs: number) => unknown;
    clear: (timer: unknown) => void;
};

export type CanvasProjectSaveQueue<T> = {
    schedule: (snapshot: T, delayMs?: number) => void;
    flush: () => void;
};

const browserScheduler: CanvasProjectSaveScheduler = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer as number),
};

export function createCanvasProjectSaveQueue<T>(delayMs: number, onFlush: (snapshot: T) => void, scheduler: CanvasProjectSaveScheduler = browserScheduler): CanvasProjectSaveQueue<T> {
    let timer: unknown | null = null;
    let pending: T | null = null;

    const flush = () => {
        if (timer !== null) {
            scheduler.clear(timer);
            timer = null;
        }
        const snapshot = pending;
        pending = null;
        if (snapshot !== null) onFlush(snapshot);
    };

    return {
        schedule(snapshot: T, nextDelayMs = delayMs) {
            pending = snapshot;
            if (timer !== null) scheduler.clear(timer);
            timer = scheduler.set(flush, nextDelayMs);
        },
        flush,
    };
}
