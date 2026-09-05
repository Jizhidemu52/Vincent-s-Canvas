import { expect, test } from "bun:test";

import { createCanvasTextStreamBuffer } from "@/lib/canvas/canvas-text-stream-buffer";

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
