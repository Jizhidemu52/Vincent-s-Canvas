type ImageOperationFeedback = {
    start: () => void;
    error: (error: unknown) => void;
    finish: () => void;
};

/** Owns the busy indicator and cancellation of local image tools, not AI requests. */
export function createCanvasImageOperationRunner() {
    const pending = new Map<string, AbortController>();
    return {
        async run(key: string, task: (signal: AbortSignal) => Promise<void>, feedback: ImageOperationFeedback, timeoutMs = 60_000) {
            if (pending.has(key)) return false;
            const controller = new AbortController();
            const { signal } = controller;
            pending.set(key, controller);
            let rejectAbort: (reason?: unknown) => void = () => {};
            const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
            const abort = () => rejectAbort(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => controller.abort(new DOMException("处理超时，请重试", "TimeoutError")), timeoutMs);
            try {
                feedback.start();
                await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return task(signal); }), aborted]);
                return true;
            } catch (error) {
                if (!(error instanceof Error && error.name === "AbortError")) feedback.error(error);
                // Stops remaining split pieces after one upload/encode fails.
                controller.abort();
                return false;
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                if (pending.get(key) === controller) pending.delete(key);
                feedback.finish();
            }
        },
        cancelAll() {
            for (const controller of pending.values()) controller.abort();
            pending.clear();
        },
    };
}
