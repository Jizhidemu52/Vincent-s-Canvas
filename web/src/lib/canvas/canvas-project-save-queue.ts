export type CanvasProjectSaveScheduler = {
    set: (callback: () => void, delayMs: number) => unknown;
    clear: (timer: unknown) => void;
};

export type CanvasProjectSaveQueue<T> = {
    schedule: (snapshot: T, delayMs?: number) => void;
    flush: () => void;
    resume: () => boolean;
    discard: () => void;
    hasPending: () => boolean;
};

const browserScheduler: CanvasProjectSaveScheduler = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer as number),
};

export function createCanvasProjectSaveQueue<T>(delayMs: number, onFlush: (snapshot: T) => void, scheduler: CanvasProjectSaveScheduler = browserScheduler, shouldFlush: () => boolean = () => true): CanvasProjectSaveQueue<T> {
    let timer: unknown | null = null;
    let deadline: unknown | null = null;
    let pending: T | null = null;
    let deferred = false;

    const clearTimers = () => {
        if (deadline !== null) { scheduler.clear(deadline); deadline = null; }
        if (timer !== null) {
            scheduler.clear(timer);
            timer = null;
        }
    };
    const flush = () => {
        clearTimers();
        // A suspended editor keeps its pending snapshot until it regains the
        // same lease. Do not consume it merely because the write is fenced.
        if (pending === null) return;
        if (!shouldFlush()) { deferred = true; return; }
        const snapshot = pending;
        pending = null;
        deferred = false;
        if (snapshot !== null) onFlush(snapshot);
    };

    return {
        schedule(snapshot: T, nextDelayMs = delayMs) {
            if (deadline === null) deadline = scheduler.set(flush, 3000);
            pending = snapshot;
            if (timer !== null) scheduler.clear(timer);
            timer = scheduler.set(flush, nextDelayMs);
        },
        flush,
        resume: () => { if (!deferred) return false; flush(); return !deferred; },
        discard: () => { clearTimers(); pending = null; deferred = false; },
        hasPending: () => pending !== null,
    };
}
