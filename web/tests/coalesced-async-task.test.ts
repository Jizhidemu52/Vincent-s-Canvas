import { expect, test } from "bun:test";

import { createCoalescedAsyncTask } from "@/lib/coalesced-async-task";

test("coalesces queued work into one asynchronous flush", async () => {
    const callbacks: Array<() => void> = [];
    const batches: string[][] = [];
    const task = createCoalescedAsyncTask(
        async (items: string[]) => batches.push(items),
        (callback) => callbacks.push(callback),
    );

    task.schedule("first");
    task.schedule("second");

    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    await Promise.resolve();

    expect(batches).toEqual([["first", "second"]]);
});

test("queues follow-up work until the active flush completes", async () => {
    const callbacks: Array<() => void> = [];
    const batches: string[][] = [];
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
        release = resolve;
    });
    const task = createCoalescedAsyncTask(
        async (items: string[]) => {
            batches.push(items);
            await running;
        },
        (callback) => callbacks.push(callback),
    );

    task.schedule("first");
    callbacks.shift()?.();
    await Promise.resolve();
    task.schedule("second");

    expect(callbacks).toHaveLength(0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    await Promise.resolve();

    expect(batches).toEqual([["first"], ["second"]]);
});

test("continues with a later batch when an earlier flush fails", async () => {
    const callbacks: Array<() => void> = [];
    const completed: string[][] = [];
    let attempts = 0;
    const task = createCoalescedAsyncTask(async (items: string[]) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary storage failure");
        completed.push(items);
    }, (callback) => callbacks.push(callback));

    task.schedule("first");
    callbacks.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    task.schedule("second");

    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    await Promise.resolve();

    expect(completed).toEqual([["second"]]);
});
