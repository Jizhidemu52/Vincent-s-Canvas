import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";

export const CANVAS_PROJECT_BUDGET = {
    // v0.5.18 adds first-gesture selection/resize, edit ownership, reconnect,
    // version stacks and editor-session state. Measured entry: 330110 B raw /
    // 113356 B gzip, versus v0.5.16's 259801 / 88849 B. This is an explicit
    // feature-budget increase, not a claim of passing the old 255/87 KiB gate.
    // Image editing, PDF, assistant processing and arrange algorithms stay lazy.
    // Keep tight headroom; unchanged frame/heap budgets are enforced separately.
    rawBytes: 325 * 1024,
    gzipBytes: 112 * 1024,
};

export function bundleBudgetViolations(entries) {
    return entries.flatMap((entry) => {
        const violations = [];
        if (entry.bytes > CANVAS_PROJECT_BUDGET.rawBytes) {
            violations.push(`${entry.name} exceeds raw budget: ${entry.bytes} B > ${CANVAS_PROJECT_BUDGET.rawBytes} B`);
        }
        if (entry.gzipBytes > CANVAS_PROJECT_BUDGET.gzipBytes) {
            violations.push(`${entry.name} exceeds gzip budget: ${entry.gzipBytes} B > ${CANVAS_PROJECT_BUDGET.gzipBytes} B`);
        }
        return violations;
    });
}

// Vite's default content hash is eight characters. A separate workbench module
// named project-session is not the canvas route and must not match this gate.
export function isCanvasProjectBundle(name) {
    return /^project-[A-Za-z0-9_-]{8}\.js$/.test(name);
}

function projectEntries(distDirectory) {
    const assetsDir = resolve(distDirectory, "assets");
    return readdirSync(assetsDir)
        .filter(isCanvasProjectBundle)
        .map((name) => {
            const path = resolve(assetsDir, name);
            const content = readFileSync(path);
            // Bun and Node use different native zlib implementations. A fixed JS
            // compressor keeps this build gate identical locally and in Docker.
            return { name, bytes: statSync(path).size, gzipBytes: gzipSync(content, { level: 6, mtime: 0 }).length };
        });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const entries = projectEntries(process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, "../dist"));
    if (entries.length !== 1) throw new Error(`Expected exactly one canvas project bundle, found ${entries.length}.`);

    const violations = bundleBudgetViolations(entries);
    if (violations.length) throw new Error(violations.join("\n"));

    const [entry] = entries;
    console.log(`Canvas bundle budget passed: ${entry.name} (${entry.bytes} B raw, ${entry.gzipBytes} B gzip).`);
}
