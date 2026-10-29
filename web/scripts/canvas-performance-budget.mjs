export const BUDGET = Object.freeze({ version: 1, p95Ratio: 1.35, meanFrameRatio: 1.3, longFrameRateIncrease: 0.04, heapPeakRatio: 1.35, historyHeapIncreaseMiB: 32, afterCapIncreaseMiB: 2 });

export function memoryBudgetFailures(memory) {
    const failures = [];
    const growth = memory.growthThrough220MiB ?? memory.growthMiB;
    if (growth > BUDGET.historyHeapIncreaseMiB) failures.push(`JS heap growth ${growth.toFixed(2)} MiB > ${BUDGET.historyHeapIncreaseMiB} MiB`);
    if (memory.afterCapMiB > BUDGET.afterCapIncreaseMiB) failures.push(`Post-cap JS heap growth ${memory.afterCapMiB.toFixed(2)} MiB > ${BUDGET.afterCapIncreaseMiB} MiB`);
    if (memory.sharing.sharingClusterArrays < 200 || memory.sharing.unchangedNodeMaxCopies !== 1 || memory.sharing.sharingClusterUniqueNodes > 705) failures.push("Retained snapshot graph exceeds the 200-frame shared-node boundary");
    return failures;
}

export function summarizeFrames(frames, hiddenCount = 0) {
    const sorted = [...frames].sort((a, b) => a - b), duration = frames.reduce((sum, value) => sum + value, 0);
    return { count: frames.length, meanMs: frames.length ? duration / frames.length : 0, p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] || 0,
        maxMs: sorted.at(-1) || 0, longFrameRate: frames.length ? frames.filter(value => value > 50).length / frames.length : 0,
        stalledCount: frames.filter(value => value >= 750).length, invalidCount: frames.filter(value => !Number.isFinite(value) || value <= 0).length, hiddenCount, durationMs: duration };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export function comparePerformance(baseline, candidate) {
    const failures = [], comparisons = [];
    if (baseline.scene.sha256 !== candidate.scene.sha256 || JSON.stringify(baseline.environment) !== JSON.stringify(candidate.environment)) failures.push("Scene/browser/viewport mismatch; comparison is invalid");
    for (const label of ["pan", "zoom", "drag"]) {
        const before = baseline.interactions.filter(item => item.label === label), after = candidate.interactions.filter(item => item.label === label);
        if (before.length < 3 || after.length !== before.length) { failures.push(`${label}: missing matched repetitions`); continue; }
        for (const sample of [...before, ...after]) {
            if (sample.frames.count < 40 || sample.frames.hiddenCount || sample.frames.stalledCount || sample.frames.invalidCount) failures.push(`${label}: invalid/throttled sample (${sample.frames.count} frames, ${sample.frames.hiddenCount} hidden, ${sample.frames.stalledCount} stalls, ${sample.frames.invalidCount || 0} invalid)`);
        }
        const row = { label, baselineP95: median(before.map(item => item.frames.p95Ms)), candidateP95: median(after.map(item => item.frames.p95Ms)),
            baselineMean: median(before.map(item => item.frames.meanMs)), candidateMean: median(after.map(item => item.frames.meanMs)),
            longRateIncrease: median(after.map(item => item.frames.longFrameRate)) - median(before.map(item => item.frames.longFrameRate)) };
        row.p95Ratio = row.candidateP95 / row.baselineP95; row.meanRatio = row.candidateMean / row.baselineMean;
        if (row.p95Ratio > BUDGET.p95Ratio) failures.push(`${label}: P95 ratio ${row.p95Ratio.toFixed(3)} > ${BUDGET.p95Ratio}`);
        if (row.meanRatio > BUDGET.meanFrameRatio) failures.push(`${label}: mean-frame ratio ${row.meanRatio.toFixed(3)} > ${BUDGET.meanFrameRatio}`);
        if (row.longRateIncrease > BUDGET.longFrameRateIncrease) failures.push(`${label}: long-frame rate increased ${(row.longRateIncrease * 100).toFixed(1)} percentage points`);
        if ([...before, ...after].every(item => item.productMetrics && Number.isFinite(item.productMetrics.p95Ms))) {
            row.trackerP95Ratio = median(after.map(item => item.productMetrics.p95Ms)) / median(before.map(item => item.productMetrics.p95Ms));
            if (row.trackerP95Ratio > BUDGET.p95Ratio) failures.push(`${label}: existing tracker P95 ratio ${row.trackerP95Ratio.toFixed(3)} > ${BUDGET.p95Ratio}`);
        } else failures.push(`${label}: existing product tracker evidence missing`);
        comparisons.push(row);
    }
    if (baseline.memory && candidate.memory) {
        const peak = report => Math.max(...report.memory.curve.map(point => point.usedSize));
        const ratio = peak(candidate) / peak(baseline);
        if (ratio > BUDGET.heapPeakRatio) failures.push(`Post-GC JS heap peak ratio ${ratio.toFixed(3)} > ${BUDGET.heapPeakRatio}`);
        comparisons.push({ label: "heap", baselinePeakBytes: peak(baseline), candidatePeakBytes: peak(candidate), ratio });
        failures.push(...memoryBudgetFailures(candidate.memory));
    }
    return { pass: failures.length === 0, budget: BUDGET, comparisons, failures };
}
