import { expect, test } from "bun:test";
import { observeCanvasImageTask, type CanvasImageTaskBinding, type CanvasImageTaskRecoveryOptions } from "@/lib/canvas/canvas-image-task-recovery";
import type { QueuedTask } from "@/services/api/generation-tasks";

const binding: CanvasImageTaskBinding = { requestId: "request:2", taskId: "task-original", ownerId: "owner-a", projectId: "project-a", resultIndex: 2 };
const task = (status = "success", patch: Partial<QueuedTask> = {}): QueuedTask => ({ id: "task-original", requestId: binding.requestId, status, resultUrls: ["/api/assets/result/content"], failureReason: null, ...patch });

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup(overrides: Partial<CanvasImageTaskRecoveryOptions> = {}) {
    const controller = new AbortController();
    const queries: string[] = [];
    const seen: QueuedTask[] = [];
    const options: CanvasImageTaskRecoveryOptions = {
        signal: controller.signal,
        isCurrent: () => true,
        getTask: async (id, signal) => { expect(signal).toBe(controller.signal); queries.push(`id:${id}`); return task(); },
        getByRequestId: async (id, signal) => { expect(signal).toBe(controller.signal); queries.push(`request:${id}`); return task(); },
        onTask: value => { seen.push(value); },
        wait: async () => {},
        ...overrides,
    };
    return { controller, queries, seen, options };
}

function trackAbortListeners(signal: AbortSignal) {
    const listeners = new Set<EventListenerOrEventListenerObject | null>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => { if (type === "abort") listeners.add(listener); add(type, listener, options); };
    signal.removeEventListener = (type, listener, options) => { if (type === "abort") listeners.delete(listener); remove(type, listener, options); };
    return listeners;
}

test("bound task uses only the injected single-task query and returns its original result", async () => {
    const info = setup();
    const listeners = trackAbortListeners(info.controller.signal);
    expect(await observeCanvasImageTask(binding, info.options)).toEqual(task());
    expect(info.queries).toEqual(["id:task-original"]);
    expect(info.seen).toEqual([task()]);
    expect(listeners.size).toBe(0);
});

test("processing waits for persistence, then polls the same task until success", async () => {
    const persisted = deferred<void>();
    const notified = deferred<void>();
    const events: string[] = [];
    let queryCount = 0;
    const info = setup({
        getTask: async id => { expect(id).toBe(binding.taskId); events.push("query"); return task(queryCount++ ? "success" : "processing"); },
        onTask: async value => { events.push(`persist:${value.status}`); if (value.status === "processing") { notified.resolve(); await persisted.promise; events.push("persisted"); } },
        wait: async () => { events.push("wait"); },
    });
    const observed = observeCanvasImageTask(binding, info.options);
    await notified.promise;
    expect(events).toEqual(["query", "persist:processing"]);
    persisted.resolve();
    expect((await observed)?.status).toBe("success");
    expect(events).toEqual(["query", "persist:processing", "persisted", "wait", "query", "persist:success"]);
});

test("request-only binding uses the exact request ID once, persists the ID, then uses direct queries", async () => {
    const events: string[] = [];
    const info = setup({
        getByRequestId: async id => { events.push(`request:${id}`); return task("waiting"); },
        getTask: async id => { events.push(`task:${id}`); return task(); },
        onTask: value => { events.push(`persist:${value.id}`); },
        wait: async () => { events.push("wait"); },
    });
    const requestOnly = { ...binding, taskId: undefined };
    expect(await observeCanvasImageTask(requestOnly, info.options)).toEqual(task());
    expect(events).toEqual(["request:request:2", "persist:task-original", "wait", "task:task-original", "persist:task-original"]);
    expect(requestOnly.taskId).toBeUndefined();
});

test.each(["success", "paused", "failed", "cancelled"])("%s is terminal and never waits or resubmits", async status => {
    const result = task(status);
    const info = setup({ getTask: async () => result, wait: async () => { throw new Error("Unexpected wait"); } });
    expect(await observeCanvasImageTask(binding, info.options)).toBe(result);
    expect(info.seen).toEqual([result]);
});

test.each([true, false])("missing task returns null without alternate lookup or resubmission (taskId=%s)", async hasId => {
    let queries = 0;
    const info = setup({
        getTask: async () => { expect(hasId).toBe(true); queries++; return null; },
        getByRequestId: async () => { expect(hasId).toBe(false); queries++; return null; },
        wait: async () => { throw new Error("Unexpected wait"); },
    });
    expect(await observeCanvasImageTask({ ...binding, taskId: hasId ? binding.taskId : undefined }, info.options)).toBeNull();
    expect(queries).toBe(1);
    expect(info.seen).toEqual([]);
});

test.each([
    { requestId: "request:other" },
    { id: "task-other" },
    { ownerUserId: "owner-other" },
    { userId: "owner-other" },
    { ownerUserId: "owner-a", userId: "owner-other" },
])("rejects mismatched identity before publishing (%j)", async patch => {
    const info = setup({ getTask: async () => task("success", patch) });
    await expect(observeCanvasImageTask(binding, info.options)).rejects.toThrow("标识或归属不匹配");
    expect(info.seen).toEqual([]);
});

test("exact matching owners are accepted, and request lookup is validated independently", async () => {
    const info = setup({ getTask: async () => task("success", { userId: binding.ownerId, ownerUserId: binding.ownerId }) });
    expect((await observeCanvasImageTask(binding, info.options))?.status).toBe("success");
    info.options.getByRequestId = async () => task("success", { requestId: "request:0" });
    await expect(observeCanvasImageTask({ ...binding, taskId: undefined }, info.options)).rejects.toThrow("标识或归属不匹配");
    expect(info.seen).toHaveLength(1);
});

test.each(["unknown", "", "queued"])("unknown status %s stops with an error", async status => {
    const info = setup({ getTask: async () => task(status), wait: async () => { throw new Error("Unexpected wait"); } });
    await expect(observeCanvasImageTask(binding, info.options)).rejects.toThrow("任务状态未知");
    expect(info.seen).toEqual([]);
});

test.each(["node deleted", "project switched", "owner switched"])("isCurrent rejects a late query after %s", async change => {
    const current = { nodeExists: true, projectId: binding.projectId, ownerId: binding.ownerId };
    const started = deferred<void>();
    const response = deferred<QueuedTask>();
    const info = setup({
        isCurrent: () => current.nodeExists && current.projectId === binding.projectId && current.ownerId === binding.ownerId,
        getTask: async () => { started.resolve(); return response.promise; },
    });
    const observed = observeCanvasImageTask(binding, info.options);
    await started.promise;
    if (change === "node deleted") current.nodeExists = false;
    else if (change === "project switched") current.projectId = "project-b";
    else current.ownerId = "owner-b";
    response.resolve(task());
    await expect(observed).rejects.toMatchObject({ name: "AbortError" });
    expect(info.seen).toEqual([]);
});

test.each(["persist", "wait"])("isCurrent rejects after asynchronous %s and makes no new query", async stage => {
    let current = true;
    let queries = 0;
    const entered = deferred<void>();
    const pending = deferred<void>();
    const pause = async () => { entered.resolve(); await pending.promise; };
    const info = setup({
        isCurrent: () => current,
        getTask: async () => { queries++; return task("processing"); },
        onTask: stage === "persist" ? pause : () => {},
        wait: stage === "wait" ? pause : async () => { throw new Error("Unexpected wait"); },
    });
    const observed = observeCanvasImageTask(binding, info.options);
    await entered.promise;
    current = false;
    pending.resolve();
    await expect(observed).rejects.toMatchObject({ name: "AbortError" });
    expect(queries).toBe(1);
});

test("already invalid context or aborted signal makes no request", async () => {
    const info = setup({ isCurrent: () => false });
    await expect(observeCanvasImageTask(binding, info.options)).rejects.toMatchObject({ name: "AbortError" });
    info.options.isCurrent = () => true;
    info.controller.abort("caller reason");
    await expect(observeCanvasImageTask(binding, info.options)).rejects.toMatchObject({ name: "AbortError" });
    expect(info.queries).toEqual([]);
});

test.each(["query", "persist", "wait"])("abort interrupts an uncooperative %s promise and cleans listeners", async stage => {
    const entered = deferred<void>();
    const pending = deferred<void>();
    const pause = async () => { entered.resolve(); await pending.promise; };
    const info = setup({
        getTask: async () => { if (stage === "query") await pause(); return task("processing"); },
        onTask: stage === "persist" ? pause : () => {},
        wait: stage === "wait" ? pause : async () => { throw new Error("Unexpected wait"); },
    });
    const listeners = trackAbortListeners(info.controller.signal);
    const rejected = observeCanvasImageTask(binding, info.options).catch(error => error);
    await entered.promise;
    info.controller.abort("caller cancellation");
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(listeners.size).toBe(0);
    pending.resolve();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
});

test("default wait delays the next query by one second and cleans both timer and observation listeners", async () => {
    let queries = 0;
    const timestamps: number[] = [];
    const info = setup({ wait: undefined, getTask: async () => { timestamps.push(performance.now()); return task(queries++ ? "success" : "waiting"); } });
    const listeners = trackAbortListeners(info.controller.signal);
    expect((await observeCanvasImageTask(binding, info.options))?.status).toBe("success");
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(950);
    expect(listeners.size).toBe(0);
});

test("abort cancels the default polling timer without an extra query", async () => {
    const persisted = deferred<void>();
    let queries = 0;
    const info = setup({ wait: undefined, getTask: async () => { queries++; return task("processing"); }, onTask: () => { persisted.resolve(); } });
    const listeners = trackAbortListeners(info.controller.signal);
    const rejected = observeCanvasImageTask(binding, info.options).catch(error => error);
    await persisted.promise;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(listeners.size).toBe(2);
    info.controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(queries).toBe(1);
    expect(listeners.size).toBe(0);
});

test.each(["query", "persist", "wait"])("%s failure propagates and releases abort listeners", async stage => {
    const failure = new Error(`${stage} failed`);
    const info = setup({
        getTask: async () => { if (stage === "query") throw failure; return task("processing"); },
        onTask: () => { if (stage === "persist") throw failure; },
        wait: async () => { throw failure; },
    });
    const listeners = trackAbortListeners(info.controller.signal);
    await expect(observeCanvasImageTask(binding, info.options)).rejects.toBe(failure);
    expect(listeners.size).toBe(0);
});
