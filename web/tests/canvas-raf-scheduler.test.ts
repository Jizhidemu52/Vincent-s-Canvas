import { expect, test } from "bun:test";

import { createRafLatestScheduler } from "@/lib/canvas/canvas-raf-scheduler";

test("coalesces high-frequency values to the latest animation-frame update", () => {
    let frameCallback: (() => void) | undefined;
    const updates: number[] = [];
    const scheduler = createRafLatestScheduler(
        (callback) => {
            frameCallback = callback;
            return 17;
        },
        () => undefined,
        (value) => updates.push(value),
    );

    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.schedule(3);

    expect(updates).toEqual([]);
    frameCallback?.();
    expect(updates).toEqual([3]);
});

test("flushes a pending final value and cancels a scheduled frame", () => {
    let cancelledFrame: number | undefined;
    const updates: string[] = [];
    const scheduler = createRafLatestScheduler(
        () => 23,
        (frame) => {
            cancelledFrame = frame;
        },
        (value) => updates.push(value),
    );

    scheduler.schedule("final");
    scheduler.flush();

    expect(updates).toEqual(["final"]);
    expect(cancelledFrame).toBe(23);
});
