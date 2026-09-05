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

    queue.schedule("draft");
    queue.flush();

    expect(saved).toEqual(["draft"]);
    expect(timers.count()).toBe(0);
});

test("lets batch generation request a longer coalescing delay", () => {
    const timers = createTimerScheduler();
    const queue = createCanvasProjectSaveQueue(180, () => undefined, timers.scheduler);

    queue.schedule("batch-result", 900);

    expect(timers.requestedDelays()).toEqual([900]);
});
