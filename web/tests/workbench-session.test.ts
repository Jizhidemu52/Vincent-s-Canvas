import { expect, test } from "bun:test";
import { createWorkbenchSessionStore } from "@/stores/workbench-session-store";
import { createSubmissionGate } from "@/lib/submission-gate";
import { createDedupedAsyncResolver } from "@/lib/deduped-async-resolver";

test("workbench drafts retain independent fields and functional updates without redundant notifications", () => {
    const store = createWorkbenchSessionStore();
    store.getState().activate("designer-a");
    const update = store.getState().update;
    update("designer-a", "image:prompt", "image draft", "");
    update("designer-a", "video:prompt", "video draft", "");
    update("designer-a", "assets:page", (page: number) => page + 1, 1);
    expect(store.getState().values).toEqual({ "image:prompt": "image draft", "video:prompt": "video draft", "assets:page": 2 });
    const before = store.getState();
    update("designer-a", "image:prompt", "image draft", "");
    store.getState().activate("designer-a");
    expect(store.getState()).toBe(before);
});

test("account changes clear drafts and reject stale asynchronous updates from the previous user", () => {
    const store = createWorkbenchSessionStore();
    store.getState().activate("a");
    store.getState().update("a", "prompt", "private", "");
    store.getState().activate("b");
    store.getState().update("a", "prompt", "late private response", "");
    expect(store.getState().values).toEqual({});
    store.getState().update("b", "prompt", "new", "");
    store.getState().activate(null);
    expect(store.getState().values).toEqual({});
});

test("submission leases block rapid duplicates, isolate workflows and cannot release a newer lease", () => {
    const gate = createSubmissionGate();
    const release = gate.acquire("image:a")!;
    expect(gate.acquire("image:a")).toBeNull();
    expect(gate.acquire("video:a")).not.toBeNull();
    expect(gate.acquire("image:b")).not.toBeNull();
    release();
    const next = gate.acquire("image:a");
    expect(next).not.toBeNull();
    release();
    expect(gate.acquire("image:a")).toBeNull();
    next!();
    expect(gate.acquire("image:a")).not.toBeNull();
});

test("a failed asynchronous operation releases its submission lease", async () => {
    const gate = createSubmissionGate();
    const run = async () => {
        const release = gate.acquire("video:a")!;
        try { throw new Error("offline"); } finally { release(); }
    };
    await expect(run()).rejects.toThrow("offline");
    expect(gate.acquire("video:a")).not.toBeNull();
});

test("returning views share the pending video job and both receive its result", async () => {
    const share = createDedupedAsyncResolver<number, [() => Promise<number>]>((_key, run) => run());
    let finish!: (value: number) => void;
    let calls = 0;
    const original = share("owner:task", () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const returning = share("owner:task", async () => { calls++; return 99; });
    expect(returning).toBe(original);
    finish(42);
    expect(await returning).toBe(42);
    expect(calls).toBe(1);
    expect(await share("owner:task", async () => 100)).toBe(100);
});
