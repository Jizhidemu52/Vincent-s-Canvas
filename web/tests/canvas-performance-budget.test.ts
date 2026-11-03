import { expect, test } from "bun:test";
import { comparePerformance, memoryBudgetFailures, summarizeFrames } from "../scripts/canvas-performance-budget.mjs";
import { performanceRaster } from "../e2e/canvas-performance-fixture";
import { startPerformanceFrameProbe } from "../e2e/canvas-performance-frame-probe";
import { runInNewContext } from "node:vm";

function frameProbe() {
    let nextId = 0;
    const callbacks = new Map<number, (timestamp: number) => void>();
    const timers = new Map<number, () => void>();
    const listeners = new Set<() => void>();
    const document = { hidden: false, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
    const window: any = { setTimeout: (fn: () => void) => { const id = ++nextId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) };
    // Evaluate the same serialized function used by Playwright, with only the
    // browser clock/scheduler replaced. No production globals are overwritten.
    const ready: Promise<void> = runInNewContext(`(${startPerformanceFrameProbe.toString()})(0)`, {
        window, document, performance: { now: () => 0 },
        requestAnimationFrame: (callback: (timestamp: number) => void) => { const id = ++nextId; callbacks.set(id, callback); return id; },
        cancelAnimationFrame: (id: number) => callbacks.delete(id),
    });
    return { ready, window, document, listeners, timers, callbacks, frame(timestamp: number) {
        const scheduled = [...callbacks.values()]; callbacks.clear();
        for (const callback of scheduled) callback(timestamp);
    } };
}

const report = (duration: number) => ({ scene: { sha256: "same" }, environment: { browser: "same" },
    interactions: ["pan", "zoom", "drag"].flatMap(label => Array.from({ length: 3 }, () => ({ label, frames: summarizeFrames(Array(100).fill(duration)), productMetrics: { p95Ms: duration } }))) });
test("performance budget compares the fixed baseline, not candidate self-calibration", () => {
    expect(comparePerformance(report(16), report(18)).pass).toBe(true);
    const failed = comparePerformance(report(16), report(65));
    expect(failed.pass).toBe(false);
    expect(failed.failures.some(failure => failure.includes("P95 ratio"))).toBe(true);
    expect(failed.failures.some(failure => failure.includes("mean-frame"))).toBe(true);
});
test("hidden, missing, and >=750ms frames cannot disappear into a passing sample", () => {
    const candidate = report(16);
    candidate.interactions[0].frames = summarizeFrames([...Array(100).fill(16), 1000], 1);
    expect(candidate.interactions[0].frames.maxMs).toBe(1000);
    expect(comparePerformance(report(16), candidate).pass).toBe(false);
    candidate.interactions = candidate.interactions.slice(1);
    expect(comparePerformance(report(16), candidate).pass).toBe(false);
});
test("non-positive or non-finite frame samples fail instead of improving averages", () => {
    for (const invalid of [-7, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
        const candidate = report(16);
        candidate.interactions[0].frames = summarizeFrames([...Array(100).fill(16), invalid]);
        expect(candidate.interactions[0].frames.invalidCount).toBe(1);
        expect(comparePerformance(report(16), candidate).pass).toBe(false);
    }
});
test("probe readiness waits for an advancing RAF clock before the gesture and retains startup evidence", async () => {
    const probe = frameProbe();
    let ready = false; void probe.ready.then(() => { ready = true; });
    probe.frame(100); probe.frame(100); await Promise.resolve();
    expect(ready).toBe(false);
    expect(probe.window.__performanceFrames.state.frames).toHaveLength(0);
    probe.frame(116); await probe.ready;
    expect(ready).toBe(true);
    probe.frame(132); probe.frame(148);
    const state = probe.window.__performanceFrames.state;
    expect([...state.startupTimestamps]).toEqual([100, 100, 116]);
    expect([...state.timestamps]).toEqual([116, 132, 148]);
    expect([...state.frames]).toEqual([16, 16]);
    probe.window.__performanceFrames.stop();
    expect(probe.callbacks.size).toBe(0);
    expect(probe.timers.size).toBe(0);
    expect(probe.listeners.size).toBe(0);
});
test("invalid timestamps after readiness are retained and still fail the unchanged budget", async () => {
    for (const timestamp of [116, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
        const probe = frameProbe();
        probe.frame(100); probe.frame(116); await probe.ready;
        probe.frame(timestamp);
        expect([...probe.window.__performanceFrames.state.frames]).toEqual([timestamp - 116]);
        const candidate = report(16);
        candidate.interactions[0].frames = summarizeFrames([...Array(100).fill(16), ...probe.window.__performanceFrames.state.frames]);
        expect(candidate.interactions[0].frames.invalidCount).toBe(1);
        expect(comparePerformance(report(16), candidate).pass).toBe(false);
        probe.window.__performanceFrames.stop();
    }
});
test("invalid startup clocks and a clock that never advances fail with scheduler cleanup", async () => {
    for (const timestamp of [90, Number.NaN, Number.POSITIVE_INFINITY]) {
        const invalid = frameProbe();
        invalid.frame(100); invalid.frame(timestamp);
        await expect(invalid.ready).rejects.toThrow("Invalid RAF clock");
        expect(invalid.callbacks.size).toBe(0); expect(invalid.timers.size).toBe(0); expect(invalid.listeners.size).toBe(0);
    }
    const slow = frameProbe();
    slow.frame(100); slow.frame(850);
    await expect(slow.ready).rejects.toThrow("RAF clock stalled");
    expect(slow.callbacks.size).toBe(0); expect(slow.timers.size).toBe(0); expect(slow.listeners.size).toBe(0);
    const stalled = frameProbe();
    stalled.frame(100); stalled.frame(100);
    for (const timeout of [...stalled.timers.values()]) timeout();
    await expect(stalled.ready).rejects.toThrow("RAF clock did not advance");
    expect(stalled.callbacks.size).toBe(0); expect(stalled.timers.size).toBe(0); expect(stalled.listeners.size).toBe(0);
});
test("hidden startup state is retained instead of being cleared at readiness", async () => {
    const probe = frameProbe();
    probe.document.hidden = true;
    for (const visibility of probe.listeners) visibility();
    probe.frame(100); probe.frame(116); await probe.ready;
    probe.document.hidden = false;
    probe.frame(132);
    const candidate = report(16);
    candidate.interactions[0].frames = summarizeFrames(Array(100).fill(16), probe.window.__performanceFrames.state.hiddenCount);
    expect(candidate.interactions[0].frames.hiddenCount).toBe(1);
    expect(comparePerformance(report(16), candidate).pass).toBe(false);
    probe.window.__performanceFrames.stop();
});
test("PNG workload is deterministic, correctly dimensioned and distinct", () => {
    const a = performanceRaster(0, 256, 192), b = performanceRaster(1, 256, 192);
    expect(a.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(a.readUInt32BE(16)).toBe(256); expect(a.readUInt32BE(20)).toBe(192);
    expect(a).toEqual(performanceRaster(0, 256, 192)); expect(a).not.toEqual(b);
});
test("memory budget gates bytes and sharing separately; a 200-entry count cannot hide retention", () => {
    const memory = { growthMiB: 5, afterCapMiB: .2, sharing: { sharingClusterArrays: 202, unchangedNodeMaxCopies: 1, sharingClusterUniqueNodes: 702 } };
    expect(memoryBudgetFailures(memory)).toEqual([]);
    expect(memoryBudgetFailures({ ...memory, growthMiB: 45 })).toHaveLength(1);
    expect(memoryBudgetFailures({ ...memory, growthMiB: 31, growthThrough220MiB: 33 })).toHaveLength(1);
    expect(memoryBudgetFailures({ ...memory, afterCapMiB: 3.8 })).toHaveLength(1);
    expect(memoryBudgetFailures({ ...memory, sharing: { ...memory.sharing, sharingClusterUniqueNodes: 720 } })).toHaveLength(1);
});
