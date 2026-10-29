import { expect, test } from "bun:test";
import { comparePerformance, memoryBudgetFailures, summarizeFrames } from "../scripts/canvas-performance-budget.mjs";
import { performanceRaster } from "../e2e/canvas-performance-fixture";

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
