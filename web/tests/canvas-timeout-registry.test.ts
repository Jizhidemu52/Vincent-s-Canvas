import { expect, test } from "bun:test";

import { createCanvasTimeoutRegistry, type CanvasTimeoutScheduler } from "@/lib/canvas/canvas-timeout-registry";

function createScheduler() {
    let nextId = 0;
    const callbacks = new Map<number, () => void>();
    const scheduler: CanvasTimeoutScheduler = {
        setTimeout(callback) {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        },
        clearTimeout(handle) {
            callbacks.delete(handle as number);
        },
    };

    return {
        scheduler,
        run(handle: number) {
            const callback = callbacks.get(handle);
            callbacks.delete(handle);
            callback?.();
        },
        handles() {
            return [...callbacks.keys()];
        },
    };
}

test("replaces an older callback with the latest callback for the same key", () => {
    const manual = createScheduler();
    const registry = createCanvasTimeoutRegistry(manual.scheduler);
    const calls: string[] = [];

    registry.schedule("history", () => calls.push("older"), 0);
    registry.schedule("history", () => calls.push("latest"), 0);

    expect(manual.handles()).toHaveLength(1);
    manual.run(manual.handles()[0]!);
    expect(calls).toEqual(["latest"]);
});

test("clearAll prevents every pending transient callback from running", () => {
    const manual = createScheduler();
    const registry = createCanvasTimeoutRegistry(manual.scheduler);
    const calls: string[] = [];

    registry.schedule("history", () => calls.push("history"), 0);
    registry.schedule("batch-opening", () => calls.push("opening"), 0);
    registry.clearAll();

    expect(manual.handles()).toEqual([]);
    expect(calls).toEqual([]);
});
