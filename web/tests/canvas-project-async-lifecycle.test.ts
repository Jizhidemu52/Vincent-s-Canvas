import { expect, test } from "bun:test";

import { abortPendingCanvasRequests, createCanvasProjectAsyncLifecycle } from "@/lib/canvas/canvas-project-async-lifecycle";

test("only treats the most recent canvas project restore as current", () => {
    const lifecycle = createCanvasProjectAsyncLifecycle();
    const firstRestore = lifecycle.begin();
    const secondRestore = lifecycle.begin();

    expect(lifecycle.isCurrent(firstRestore)).toBe(false);
    expect(lifecycle.isCurrent(secondRestore)).toBe(true);

    lifecycle.invalidate(secondRestore);
    expect(lifecycle.isCurrent(secondRestore)).toBe(false);
});

test("aborts and clears every pending canvas request when leaving a project", () => {
    const aborted: string[] = [];
    const requests = new Map([
        ["one", { controller: { abort: () => aborted.push("one") } }],
        ["two", { controller: { abort: () => aborted.push("two") } }],
    ]);

    abortPendingCanvasRequests(requests);

    expect(aborted).toEqual(["one", "two"]);
    expect(requests.size).toBe(0);
});
