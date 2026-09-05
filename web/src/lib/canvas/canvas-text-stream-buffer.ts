export type CanvasTextStreamUpdate = {
    nodeId: string;
    content: string;
};

export type CanvasFrameScheduler = {
    request: (callback: () => void) => number;
    cancel: (handle: number) => void;
};

export function createCanvasFrameScheduler(): CanvasFrameScheduler {
    if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
        return { request: requestAnimationFrame, cancel: cancelAnimationFrame };
    }
    return {
        request: (callback) => setTimeout(callback, 16) as unknown as number,
        cancel: (handle) => clearTimeout(handle),
    };
}

/**
 * Coalesces fast streaming chunks into at most one canvas state write per frame.
 * The newest chunk for each node wins, so a slow render never lets stale text
 * overwrite a completed or cancelled generation.
 */
export function createCanvasTextStreamBuffer(
    onFlush: (updates: ReadonlyMap<string, string>) => void,
    scheduler: CanvasFrameScheduler = createCanvasFrameScheduler(),
) {
    const pending = new Map<string, string>();
    let frameHandle: number | null = null;

    const flush = () => {
        frameHandle = null;
        if (!pending.size) return;
        const updates = new Map(pending);
        pending.clear();
        onFlush(updates);
    };

    const schedule = () => {
        if (frameHandle !== null) return;
        frameHandle = scheduler.request(flush);
    };

    return {
        push(update: CanvasTextStreamUpdate) {
            pending.set(update.nodeId, update.content);
            schedule();
        },
        clear(nodeId: string) {
            pending.delete(nodeId);
        },
        flush,
        cancel() {
            pending.clear();
            if (frameHandle === null) return;
            scheduler.cancel(frameHandle);
            frameHandle = null;
        },
    };
}
