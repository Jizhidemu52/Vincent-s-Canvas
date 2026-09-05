import { expect, test } from "bun:test";

import { fastCanvas2DContextOptions, getFastCanvas2DContext } from "@/lib/canvas/canvas-2d-context";

test("requests a desynchronized 2D context for write-only canvas previews", () => {
    const calls: unknown[][] = [];
    const context = {} as CanvasRenderingContext2D;
    const canvas = { getContext: (...args: unknown[]) => { calls.push(args); return context; } } as unknown as HTMLCanvasElement;

    expect(getFastCanvas2DContext(canvas)).toBe(context);
    expect(calls).toEqual([["2d", fastCanvas2DContextOptions]]);
});
