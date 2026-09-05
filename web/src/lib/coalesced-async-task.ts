export function createCoalescedAsyncTask<T>(run: (items: T[]) => Promise<void>, scheduleCallback: (callback: () => void) => void) {
    let queued: T[] = [];
    let scheduled = false;
    let running = false;

    const scheduleFlush = () => {
        if (scheduled || running) return;
        scheduled = true;
        scheduleCallback(() => void flush().catch(() => undefined));
    };

    const flush = async () => {
        scheduled = false;
        if (running || !queued.length) return;
        running = true;
        const items = queued;
        queued = [];
        try {
            await run(items);
        } finally {
            running = false;
            if (queued.length) scheduleFlush();
        }
    };

    return {
        schedule(item: T) {
            queued.push(item);
            scheduleFlush();
        },
    };
}
