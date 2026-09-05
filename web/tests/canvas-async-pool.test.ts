import { expect, test } from "bun:test";

import { mapCanvasAsyncPool } from "@/lib/canvas/canvas-async-pool";

test("keeps batch media imports within the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    const run = mapCanvasAsyncPool(["a", "b", "c", "d", "e"], 2, async (value, index) => {
        active += 1;
        peak = Math.max(peak, active);
        await gates[index].promise;
        active -= 1;
        return value.toUpperCase();
    });

    await Promise.resolve();
    expect(peak).toBe(2);
    gates[0].resolve();
    gates[1].resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    gates[2].resolve();
    gates[3].resolve();
    gates[4].resolve();

    expect(await run).toEqual(["A", "B", "C", "D", "E"]);
});

test("returns an empty batch without starting a worker", async () => {
    const result = await mapCanvasAsyncPool([], 3, async (value: string) => value.toUpperCase());
    expect(result).toEqual([]);
});
