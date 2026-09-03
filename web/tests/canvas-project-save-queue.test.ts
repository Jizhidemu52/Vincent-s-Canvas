import { expect, test } from "bun:test";

import { createCanvasProjectSaveQueue } from "@/lib/canvas/canvas-project-save-queue";

type TimerCallback = () => void;

function createTimerScheduler() {
    let nextId = 0;
    const callbacks = new Map<number, TimerCallback>();
    return {
        scheduler: {
            set(callback: TimerCallback) {
                const id = nextId++;
                callbacks.set(id, callback);
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
