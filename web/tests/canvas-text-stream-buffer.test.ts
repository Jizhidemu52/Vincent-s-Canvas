import { expect, test } from "bun:test";

import { createCanvasTextStreamBuffer } from "@/lib/canvas/canvas-text-stream-buffer";

test("default scheduler preserves the browser receiver for requesting and cancelling frames", () => {
    const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    let scheduled: (() => void) | undefined;
    const cancelled: number[] = [];
    Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: function (this: unknown, callback: () => void) {
            if (this !== globalThis) throw new TypeError("Illegal invocation");
            scheduled = callback;
            return 42;
        },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: function (this: unknown, handle: number) {
            if (this !== globalThis) throw new TypeError("Illegal invocation");
            cancelled.push(handle);
        },
    });
    try {
        const flushed: Array<Array<[string, string]>> = [];
        const buffer = createCanvasTextStreamBuffer((updates) => flushed.push([...updates]));
        buffer.push({ nodeId: "text-a", content: "流式回复" });
        scheduled?.();
        expect(flushed).toEqual([[["text-a", "流式回复"]]]);
        buffer.push({ nodeId: "text-a", content: "取消回复" });
        buffer.cancel();
        expect(cancelled).toEqual([42]);
    } finally {
        if (originalRequest) Object.defineProperty(globalThis, "requestAnimationFrame", originalRequest);
        else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
        if (originalCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
        else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
});

function createFrameScheduler() {
    let nextHandle = 0;
    const callbacks = new Map<number, () => void>();
    return {
        request(callback: () => void) {
            nextHandle += 1;
            callbacks.set(nextHandle, callback);
            return nextHandle;
        },
        cancel(handle: number) {
            callbacks.delete(handle);
        },
        runFrame() {
            const scheduled = [...callbacks.values()];
            callbacks.clear();
            scheduled.forEach((callback) => callback());
        },
        get pendingFrames() {
            return callbacks.size;
        },
    };
}

test("coalesces streamed chunks by node and frame", () => {
    const scheduler = createFrameScheduler();
    const flushed: Array<Array<[string, string]>> = [];
    const buffer = createCanvasTextStreamBuffer((updates) => flushed.push([...updates.entries()]), scheduler);

    buffer.push({ nodeId: "text-a", content: "第一个" });
    buffer.push({ nodeId: "text-a", content: "最新" });
    buffer.push({ nodeId: "text-b", content: "并行" });

    expect(scheduler.pendingFrames).toBe(1);
    expect(flushed).toEqual([]);

    scheduler.runFrame();

    expect(flushed).toEqual([[['text-a', '最新'], ['text-b', '并行']]]);
});

test("clearing or cancelling pending chunks prevents stale text from publishing", () => {
    const scheduler = createFrameScheduler();
    const flushed: Array<Array<[string, string]>> = [];
    const buffer = createCanvasTextStreamBuffer((updates) => flushed.push([...updates.entries()]), scheduler);

    buffer.push({ nodeId: "cancelled", content: "旧内容" });
    buffer.clear("cancelled");
    scheduler.runFrame();
    expect(flushed).toEqual([]);

    buffer.push({ nodeId: "left-project", content: "不应出现" });
    buffer.cancel();
    scheduler.runFrame();
    expect(flushed).toEqual([]);
});
