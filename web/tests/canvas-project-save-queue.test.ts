import { expect, test } from "bun:test";

import { createCanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";

type TimerCallback = () => void;

function createTimerScheduler() {
    let nextId = 0;
    const callbacks = new Map<number, TimerCallback>();
    const delays: number[] = [];
    return {
        scheduler: {
            set(callback: TimerCallback, delayMs: number) {
                const id = nextId++;
                callbacks.set(id, callback);
                delays.push(delayMs);
                return id;
            },
            clear(id: unknown) {
                callbacks.delete(id as number);
            },
        },
        runAll() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((callback) => callback());
        },
        count() {
            return callbacks.size;
        },
        requestedDelays() {
            return delays;
        },
    };
}

test("publishes only the latest queued canvas project snapshot", () => {
    const timers = createTimerScheduler();
    const saved: string[] = [];
    const queue = createCanvasProjectSaveQueue(180, (snapshot: string) => saved.push(snapshot), timers.scheduler);

    queue.schedule("first");
    queue.schedule("latest");
    timers.runAll();

    expect(saved).toEqual(["latest"]);
    expect(timers.count()).toBe(0);
});

test("flushes a pending canvas project snapshot before the page closes", () => {
    const timers = createTimerScheduler();
    const saved: string[] = [];
    const queue = createCanvasProjectSaveQueue(180, (snapshot: string) => saved.push(snapshot), timers.scheduler);

    expect(queue.hasPending()).toBe(false);
    queue.schedule("draft");
    expect(queue.hasPending()).toBe(true);
    queue.flush();

    expect(queue.hasPending()).toBe(false);
    expect(saved).toEqual(["draft"]);
    expect(timers.count()).toBe(0);
});

test("lets batch generation request a longer coalescing delay", () => {
    const timers = createTimerScheduler();
    const queue = createCanvasProjectSaveQueue(180, () => undefined, timers.scheduler);

    queue.schedule("batch-result", 900);

    expect(timers.requestedDelays()).toEqual([3000, 900]);
});

test("an expired editor retains its pending snapshot and flushes once after same-lease recovery", () => {
    const timers = createTimerScheduler();
    const saved: string[] = [];
    let writable = true;
    const queue = createCanvasProjectSaveQueue(180, (snapshot: string) => saved.push(snapshot), timers.scheduler, () => writable);
    queue.schedule("unsaved draft");
    writable = false;
    timers.runAll();
    expect(saved).toEqual([]);
    expect(queue.hasPending()).toBe(true);
    expect(timers.count()).toBe(0);
    writable = true;
    expect(queue.resume()).toBe(true);
    expect(queue.resume()).toBe(false);
    expect(saved).toEqual(["unsaved draft"]);
    expect(queue.hasPending()).toBe(false);
});

test("discarding a backed-up stale editor prevents its queued snapshot from reaching a new holder", () => {
    const timers = createTimerScheduler();
    const saved: string[] = [];
    const queue = createCanvasProjectSaveQueue(180, (snapshot: string) => saved.push(snapshot), timers.scheduler, () => false);
    queue.schedule("old draft");
    queue.discard();
    timers.runAll();
    queue.flush();
    expect(saved).toEqual([]);
    expect(queue.hasPending()).toBe(false);
    expect(timers.count()).toBe(0);
});
