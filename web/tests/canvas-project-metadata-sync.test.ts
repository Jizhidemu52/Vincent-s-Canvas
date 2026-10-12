import { expect, test } from "bun:test";
import { createCanvasProjectMetadataSync, type CanvasProjectMetadata } from "@/lib/canvas/canvas-project-metadata-sync";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function harness(submit: (ownerId: string, project: CanvasProjectMetadata, signal: AbortSignal) => Promise<void> = async () => undefined) {
    const state = { ownerId: "employee-a", visible: true, hydrated: true, projects: [{ id: "a", title: "初稿" }] };
    const calls: Array<{ ownerId: string; project: CanvasProjectMetadata; signal: AbortSignal }> = [];
    const create = (ownerId = state.ownerId) => createCanvasProjectMetadataSync({
        ownerId,
        getProjects: () => state.projects,
        isCurrentOwner: () => state.hydrated && state.ownerId === ownerId,
        isVisible: () => state.visible,
        submit: async (ownerId, project, signal) => { calls.push({ ownerId, project, signal }); await submit(ownerId, project, signal); },
    });
    return { state, calls, create, sync: create() };
}

test("unchanged refreshes send nothing; only new and renamed projects are synchronized", async () => {
    const { state, calls, sync } = harness();
    await sync.sync();
    await sync.sync();
    expect(calls.map(call => call.project)).toEqual([{ id: "a", title: "初稿" }]);
    state.projects = [{ id: "a", title: "修订稿" }, { id: "b", title: " 新项目 " }];
    await sync.sync();
    await sync.sync();
    expect(calls.map(call => call.project)).toEqual([
        { id: "a", title: "初稿" }, { id: "a", title: "修订稿" }, { id: "b", title: "新项目" },
    ]);
});

test("only fulfilled requests are remembered; failures retry without resending successful peers", async () => {
    let fails = true;
    const { state, calls, sync } = harness(async (_owner, project) => { if (project.id === "a" && fails) throw new Error("503"); });
    state.projects.push({ id: "b", title: "成功项" });
    await sync.sync();
    fails = false;
    await sync.sync();
    await sync.sync();
    expect(calls.map(call => call.project.id)).toEqual(["a", "b", "a"]);
});

test("overlapping refreshes share a bounded four-request batch", async () => {
    const waits: Array<ReturnType<typeof deferred>> = [];
    let active = 0;
    let peak = 0;
    const { state, calls, sync } = harness(async () => {
        active += 1; peak = Math.max(peak, active);
        const wait = deferred(); waits.push(wait);
        await wait.promise; active -= 1;
    });
    state.projects = Array.from({ length: 9 }, (_, index) => ({ id: String(index), title: `项目 ${index}` }));
    const first = sync.sync();
    expect(sync.sync()).toBe(first);
    expect(calls).toHaveLength(4);
    for (let index = 0; index < 9; index++) {
        while (!waits[index]) await Promise.resolve();
        waits[index].resolve();
    }
    await first;
    await sync.sync();
    expect(calls).toHaveLength(9);
    expect(peak).toBe(4);
});

test("hidden or unhydrated workspaces do not start requests; hiding stops queued work", async () => {
    let gate = deferred();
    const { state, calls, sync } = harness(async () => gate.promise);
    state.projects = Array.from({ length: 8 }, (_, index) => ({ id: String(index), title: "项目" }));
    state.visible = false;
    await sync.sync();
    state.visible = true; state.hydrated = false;
    await sync.sync();
    expect(calls).toHaveLength(0);
    state.hydrated = true;
    const first = sync.sync();
    expect(calls).toHaveLength(4);
    state.visible = false;
    gate.resolve(); await first;
    await sync.sync();
    expect(calls).toHaveLength(4);
    state.visible = true; gate = deferred();
    const second = sync.sync(); gate.resolve(); await second;
    expect(calls).toHaveLength(8);
});

test("a rename during an outstanding request remains dirty for the next refresh", async () => {
    const gate = deferred();
    const { state, calls, sync } = harness(async () => gate.promise);
    const first = sync.sync();
    state.projects = [{ id: "a", title: "最新名称" }];
    expect(sync.sync()).toBe(first);
    gate.resolve(); await first;
    await sync.sync();
    await sync.sync();
    expect(calls.map(call => call.project.title)).toEqual(["初稿", "最新名称"]);
});

test("identity changes abort the old lifetime, stop its queue, and never reuse its success cache", async () => {
    const gate = deferred();
    const { state, calls, sync, create } = harness(async () => gate.promise);
    state.projects = Array.from({ length: 6 }, (_, index) => ({ id: String(index), title: "同名画布" }));
    const first = sync.sync();
    state.ownerId = "employee-b";
    sync.dispose();
    expect(calls.every(call => call.signal.aborted)).toBe(true);
    gate.resolve(); await first;
    await sync.sync();
    expect(calls).toHaveLength(4);
    const nextOwner = create();
    await nextOwner.sync();
    expect(calls.filter(call => call.ownerId === "employee-b")).toHaveLength(6);
    await nextOwner.sync();
    expect(calls).toHaveLength(10);
});

test("an owner mismatch stops queued submissions even before component cleanup", async () => {
    const gate = deferred();
    const { state, calls, sync } = harness(async () => gate.promise);
    state.projects = Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: "项目" }));
    const first = sync.sync();
    state.ownerId = "employee-b";
    gate.resolve(); await first;
    await sync.sync();
    expect(calls).toHaveLength(4);
});

test("deleted metadata is evicted instead of retaining an unbounded success cache", async () => {
    const { state, calls, sync } = harness();
    await sync.sync();
    state.projects = [];
    await sync.sync();
    state.projects = [{ id: "a", title: "初稿" }];
    await sync.sync();
    expect(calls).toHaveLength(2);
});
