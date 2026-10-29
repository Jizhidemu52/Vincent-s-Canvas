import { readFile, writeFile } from "node:fs/promises";
import { comparePerformance } from "./canvas-performance-budget.mjs";

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error("Usage: bun scripts/canvas-performance-compare.mjs BASELINE_JSON CANDIDATE_JSON [OUTPUT_JSON]");
const result = comparePerformance(JSON.parse(await readFile(baselinePath, "utf8")), JSON.parse(await readFile(candidatePath, "utf8")));
if (outputPath) await writeFile(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
