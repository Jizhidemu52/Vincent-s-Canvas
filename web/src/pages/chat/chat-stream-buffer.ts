type StreamScheduler = {
    request: (callback: () => void) => number;
    cancel: (handle: number) => void;
};

/** A stream callback contains accumulated text; only the newest text needs rendering. */
export function createChatStreamBuffer(onFlush: (content: string) => void, scheduler: StreamScheduler = {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
}) {
    let pending: string | undefined;
    let frame: number | null = null;
    let disposed = false;
    const flush = () => {
        if (frame !== null) scheduler.cancel(frame);
        frame = null;
        if (pending === undefined) return;
        const content = pending;
        pending = undefined;
        onFlush(content);
    };
    return {
        push(content: string) {
            if (disposed) return;
            pending = content;
            if (frame === null) frame = scheduler.request(flush);
        },
        flush,
        cancel() {
            if (frame !== null) scheduler.cancel(frame);
            frame = null;
            pending = undefined;
        },
        dispose() {
            this.cancel();
            disposed = true;
        },
    };
}
