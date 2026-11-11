import { expect, test } from "bun:test";
import { createTaskEventStream } from "../src/services/api/task-events";
import { classifyTaskRecovery, watchTaskReconciliation } from "../src/services/api/task-result-reconciliation";

function fixture() {
    let owner = "employee-a";
    const visibilityEvents = new EventTarget();
    const visibility = { hidden: false, addEventListener: visibilityEvents.addEventListener.bind(visibilityEvents), removeEventListener: visibilityEvents.removeEventListener.bind(visibilityEvents) };
    const connections: Array<{ emit: () => void; closed: boolean }> = [];
    const stream = createTaskEventStream({ owner: () => owner, visibility, connect() {
        const events = new EventTarget();
        const connection = { emit: () => events.dispatchEvent(new MessageEvent("tasks-changed", { data: JSON.stringify({ ids: ["original"] }) })), closed: false };
        connections.push(connection);
        return { addEventListener: events.addEventListener.bind(events), close: () => { connection.closed = true; } };
    } });
    const wakeTarget = new EventTarget();
    const controller = new AbortController();
    const start = (reconcile: () => Promise<void>, intervalMs = 1_000) => watchTaskReconciliation({ taskIds: ["original"], signal: controller.signal, reconcile, intervalMs, watch: stream.subscribe, visibility, wakeTarget: wakeTarget as Window }).catch(error => { if (!controller.signal.aborted) throw error; });
    return { start, connections, controller, wakeTarget, visibility, changeOwner() { owner = "employee-b"; stream.identityChanged(); }, visible() { visibility.hidden = false; visibilityEvents.dispatchEvent(new Event("visibilitychange")); } };
}

test.each([
    [undefined, "observe"], [{ status: "processing" }, "observe"],
    [{ status: "paused", upstreamTaskId: " original " }, "resume"],
    [{ status: "paused", upstreamTaskId: null }, "investigate"],
    [{ status: "paused", upstreamTaskId: "  " }, "investigate"],
    [{ status: "paused", upstreamTaskId: "original", errorCode: "IMAGE_RESULT_PROCESSING_FAILED" }, "terminal"],
    [{ status: "paused", upstreamTaskId: "original", lastFailure: { phase: "postprocess" } }, "terminal"],
    [{ status: "paused", upstreamTaskId: "original", failureReason: "渠道原件已保存到素材库，但图片后处理未完成：decoder failed" }, "terminal"],
    [{ status: "paused", upstreamTaskId: "original", lastFailure: { phase: "polling", code: "UPSTREAM_QUERY_FAILED" } }, "resume"],
    [{ status: "unexpected-state" }, "investigate"],
    [{ status: "success" }, "terminal"], [{ status: "failed" }, "terminal"], [{ status: "cancelled" }, "terminal"],
] as const)("recovery capability is structural: %j", (task, expected) => {
    expect(classifyTaskRecovery(task)).toBe(expected);
});

test("a healthy SSE stream wakes a single read-only reconciler and a missed push has a slow fallback", async () => {
    const f = fixture();
    let reads = 0;
    const run = f.start(async () => { reads++; }, 150);
    await Bun.sleep(45);
    expect(reads).toBe(1);
    expect(f.connections).toHaveLength(1);
    f.connections[0]!.emit();
    await Bun.sleep(5);
    expect(reads).toBe(2);
    // No second push: the bounded fallback must still find late success.
    await Bun.sleep(170);
    expect(reads).toBe(3);
    f.controller.abort(); await run;
    expect(f.connections[0]!.closed).toBe(true);
    f.connections[0]!.emit(); await Bun.sleep(5);
    expect(reads).toBe(3);
});

test.each(["focus", "online"])("%s refreshes promptly without a second loop or mutation", async event => {
    const f = fixture(); let reads = 0;
    const run = f.start(async () => { reads++; });
    await Bun.sleep(5);
    f.wakeTarget.dispatchEvent(new Event(event));
    await Bun.sleep(5);
    expect(reads).toBe(2);
    f.controller.abort(); await run;
    f.wakeTarget.dispatchEvent(new Event(event)); await Bun.sleep(5);
    expect(reads).toBe(2);
});

test("hidden pages do not GET; returning to the foreground reconciles the existing task", async () => {
    const f = fixture(); f.visibility.hidden = true; let reads = 0;
    const run = f.start(async () => { reads++; }, 30);
    await Bun.sleep(45); expect(reads).toBe(0);
    f.visible(); await Bun.sleep(5); expect(reads).toBe(1);
    f.controller.abort(); await run;
});

test("notifications during a read are coalesced and cannot overlap reads", async () => {
    const f = fixture(); const gate = Promise.withResolvers<void>();
    let reads = 0, concurrent = 0, peak = 0;
    const run = f.start(async () => {
        reads++; concurrent++; peak = Math.max(peak, concurrent);
        if (reads === 1) await gate.promise;
        concurrent--;
    });
    await Bun.sleep(45);
    f.connections[0]!.emit(); f.connections[0]!.emit();
    expect(reads).toBe(1);
    gate.resolve(); await Bun.sleep(5);
    expect(reads).toBe(2); expect(peak).toBe(1);
    f.controller.abort(); await run;
});

test("network failure retains the watcher with a bounded delay, not a busy retry", async () => {
    const f = fixture(); let reads = 0;
    const run = f.start(async () => { reads++; throw new Error("offline"); }, 50);
    await Bun.sleep(10); expect(reads).toBe(1);
    await Bun.sleep(55); expect(reads).toBe(2);
    f.controller.abort(); await run;
});

test("an employee change closes the original watch before another account can read", async () => {
    const f = fixture(); let reads = 0;
    const run = f.start(async () => { reads++; });
    await Bun.sleep(45);
    f.changeOwner();
    await expect(run).rejects.toThrow("员工会话已变化");
    expect(reads).toBe(1); expect(f.connections[0]!.closed).toBe(true);
});
