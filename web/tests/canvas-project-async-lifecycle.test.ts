import { expect, test } from "bun:test";

import { abortPendingCanvasRequests, canvasGenerationRunsForNodes, createCanvasProjectAsyncLifecycle, shouldCancelCanvasGeneration } from "@/lib/canvas/canvas-project-async-lifecycle";

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

test("leaving stops observation without cancelling accepted tasks; an explicit stop keeps cancellation", () => {
    const leave = new AbortController(), explicit = new AbortController();
    const requests = new Map([["one", { controller: leave }]]);
    abortPendingCanvasRequests(requests);
    explicit.abort();
    expect(leave.signal.aborted).toBe(true);
    expect(shouldCancelCanvasGeneration(leave.signal)).toBe(false);
    expect(shouldCancelCanvasGeneration(explicit.signal)).toBe(true);
});

test("deletion finds direct and shared-config generation requests, excluding unrelated work", () => {
    const requests = [
        { targetNodeId: "output", originNodeId: "source", runningNodeId: "run" },
        { targetNodeId: "other", originNodeId: "other-source", runningNodeId: "other-run" },
    ];
    const connections = [{ id: "edge", fromNodeId: "config", toNodeId: "source", kind: "config-target" as const }];
    for (const id of ["output", "source", "run", "config"]) expect([...canvasGenerationRunsForNodes(new Set([id]), requests, connections)]).toEqual(["run"]);
    expect([...canvasGenerationRunsForNodes(new Set(["unknown"]), requests, connections)]).toEqual([]);
});
