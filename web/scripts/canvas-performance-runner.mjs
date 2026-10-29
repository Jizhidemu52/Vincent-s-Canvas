import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { comparePerformance } from "./canvas-performance-budget.mjs";

const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const baselineDist = option("--baseline-dist"), candidateDist = option("--candidate-dist");
if (!baselineDist || !candidateDist) throw new Error("Usage: bun scripts/canvas-performance-runner.mjs --baseline-dist OLD_PRODUCTION_BUILD --candidate-dist NEW_PRODUCTION_BUILD [--reuse-baseline]");
const web = resolve(import.meta.dirname, ".."), output = resolve(web, "../output/canvas-performance");
const run = (variant, dist, port) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["x", "playwright", "test", "--config", "e2e/canvas-performance.config.ts"], {
        cwd: web, stdio: "inherit", windowsHide: true,
        env: { ...process.env, CANVAS_PERF_VARIANT: variant, CANVAS_PERF_DIST: resolve(dist), CANVAS_PERF_PORT: String(port) },
    });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolveRun() : reject(new Error(`${variant} browser test failed (${code}); incomplete evidence must not pass`)));
});
const read = async variant => JSON.parse(await readFile(resolve(output, variant, "report.json"), "utf8"));
const hasCompletedMemory = report => Boolean(report.memory?.sharing && report.memory.curve?.at(-1)?.step === 220 && report.memory.curve.at(-1).historyLength === 200);
if (process.argv.includes("--reuse-baseline")) {
    const saved = await read("baseline");
    const hash = createHash("sha256").update(await readFile(resolve(baselineDist, "index.html"))).digest("hex");
    if (saved.build?.indexSha256 !== hash || !saved.renderedImages?.length || saved.interactions?.length !== 9 || !hasCompletedMemory(saved)) throw new Error("Baseline build hash or completed frame/memory/image provenance is absent/mismatched; remeasure rather than reusing partial evidence");
} else await run("baseline", baselineDist, 5204);
await run("candidate", candidateDist, 5201);
const baseline = await read("baseline"), candidate = await read("candidate");
for (const report of [baseline, candidate]) {
    if (!hasCompletedMemory(report)) {
        throw new Error(`${report.variant}: missing completed real-browser memory evidence; cannot reuse a partial run`);
    }
}
const comparison = comparePerformance(baseline, candidate);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "comparison.json"), JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison, null, 2));
// Always run the negative control, even if the candidate is already red.
await run("injected", candidateDist, 5201);
const negative = comparePerformance(baseline, await read("injected"));
const negativeExitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [resolve(web, "scripts/canvas-performance-compare.mjs"), resolve(output, "baseline/report.json"), resolve(output, "injected/report.json")], { cwd: web, stdio: "inherit", windowsHide: true });
    child.once("error", reject); child.once("exit", resolveExit);
});
const detectsCpuRegression = negativeExitCode === 1 && !negative.pass && negative.failures.some(failure => /P95 ratio|mean-frame ratio|long-frame rate/.test(failure));
await writeFile(resolve(output, "fault-injection.json"), JSON.stringify({ expectedFailure: true, comparatorExitCode: negativeExitCode, detectedCpuRegression: detectsCpuRegression, ...negative }, null, 2));
const rows = comparison.comparisons.map(row => row.label === "heap"
    ? `| Post-GC JS heap peak | ${(row.baselinePeakBytes / 1024 ** 2).toFixed(2)} MiB | ${(row.candidatePeakBytes / 1024 ** 2).toFixed(2)} MiB | ${row.ratio.toFixed(3)} |`
    : `| ${row.label} P95 | ${row.baselineP95.toFixed(2)} ms | ${row.candidateP95.toFixed(2)} ms | ${row.p95Ratio.toFixed(3)} |`);
await writeFile(resolve(output, "summary.md"), `# Canvas performance comparison\n\nSame machine / same browser / 500 nodes / 100 distinct PNG images.\n\n| Metric | Baseline | Candidate | Ratio |\n| --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\nBudget: ${comparison.pass ? "PASS" : "FAIL"}. Test-only 65ms/frame negative control: ${detectsCpuRegression ? "detected (expected red)" : "FAILED TO DETECT"}.\n\n${comparison.failures.map(failure => `- ${failure}`).join("\n")}\n\nMemory measures post-GC JavaScript heap, not GPU/native decoded image memory or process RSS. The 200-history cap is a count cap, not a universal byte cap.\n`);
if (!comparison.pass || !detectsCpuRegression) process.exitCode = 1;
