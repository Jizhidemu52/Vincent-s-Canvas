import { expect, test } from "bun:test";

import { createDeferredPersistQueue, type DeferredPersistScheduler } from "@/lib/deferred-persist-queue";

function createScheduler(withIdle = true) {
    let nextId = 0;
    const timers = new Map<number, () => void>();
    const idles = new Map<number, () => void>();
    const scheduler: DeferredPersistScheduler = {
        setTimeout(callback) {
            const id = ++nextId;
            timers.set(id, callback);
            return id;
        },
        clearTimeout(handle) {
            timers.delete(handle as number);
        },
        ...(withIdle ? {
            requestIdle(callback) {
                const id = ++nextId;
                idles.set(id, callback);
                return id;
            },
            cancelIdle(handle) {
                idles.delete(handle as number);
            },
        } : {}),
    };
    return {
        scheduler,
        runTimer() {
            const entry = timers.entries().next().value as [number, () => void] | undefined;
            if (!entry) return;
            timers.delete(entry[0]);
            entry[1]();
        },
        runIdle() {
            const entry = idles.entries().next().value as [number, () => void] | undefined;
            if (!entry) return;
            idles.delete(entry[0]);
            entry[1]();
        },
    };
}

test("coalesces writes and waits for idle time after the debounce", () => {
    const manual = createScheduler();
    const writes: string[] = [];
    const queue = createDeferredPersistQueue(400, (value: string) => writes.push(value), manual.scheduler);

    queue.schedule("first");
    queue.schedule("latest");
    manual.runTimer();
    expect(writes).toEqual([]);

    manual.runIdle();
    expect(writes).toEqual(["latest"]);
});

test("falls back to the debounce callback when idle scheduling is unavailable", () => {
    const manual = createScheduler(false);
    const writes: number[] = [];
    const queue = createDeferredPersistQueue(400, (value: number) => writes.push(value), manual.scheduler);

    queue.schedule(7);
    manual.runTimer();

    expect(writes).toEqual([7]);
});

test("flush writes the newest value and clears queued work", () => {
    const manual = createScheduler();
    const writes: string[] = [];
    const queue = createDeferredPersistQueue(400, (value: string) => writes.push(value), manual.scheduler);

    queue.schedule("older");
    queue.schedule("newest");
    queue.flush();
    manual.runTimer();
    manual.runIdle();

    expect(writes).toEqual(["newest"]);
});

test("cancels a queued idle write when a newer edit arrives", () => {
    const manual = createScheduler();
    const writes: string[] = [];
    const queue = createDeferredPersistQueue(400, (value: string) => writes.push(value), manual.scheduler);

    queue.schedule("older");
    manual.runTimer();
    queue.schedule("newer");
    manual.runIdle();
    expect(writes).toEqual([]);

    manual.runTimer();
    manual.runIdle();
    expect(writes).toEqual(["newer"]);
});

test("persists null payloads instead of treating them as an empty queue", () => {
    const manual = createScheduler(false);
    const writes: Array<string | null> = [];
    const queue = createDeferredPersistQueue(400, (value: string | null) => writes.push(value), manual.scheduler);

    queue.schedule(null);
    manual.runTimer();

    expect(writes).toEqual([null]);
});

test("clear drops a queued write without flushing stale data", () => {
    const manual = createScheduler();
    const writes: string[] = [];
    const queue = createDeferredPersistQueue(400, (value: string) => writes.push(value), manual.scheduler);

    queue.schedule("obsolete");
    queue.clear();
    manual.runTimer();
    manual.runIdle();

    expect(writes).toEqual([]);
});
