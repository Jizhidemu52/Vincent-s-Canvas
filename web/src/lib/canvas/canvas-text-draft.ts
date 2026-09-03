export type CanvasTextDraftScheduler = {
    set: (callback: () => void, delayMs: number) => unknown;
    clear: (timer: unknown) => void;
};

const browserScheduler: CanvasTextDraftScheduler = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer as number),
};

export function createCanvasTextDraft(initialValue: string, onCommit: (value: string) => void, scheduler: CanvasTextDraftScheduler = browserScheduler) {
    let value = initialValue;
    let committedValue = initialValue;
    let timer: unknown | null = null;

    const flush = () => {
        if (timer !== null) {
            scheduler.clear(timer);
            timer = null;
        }
        if (value === committedValue) return;
        committedValue = value;
        onCommit(value);
    };

    return {
        change(nextValue: string) {
            value = nextValue;
            if (timer !== null) scheduler.clear(timer);
            timer = scheduler.set(flush, 180);
        },
        reset(nextValue: string) {
            if (timer !== null) scheduler.clear(timer);
            timer = null;
            value = nextValue;
            committedValue = nextValue;
        },
        flush,
    };
}
