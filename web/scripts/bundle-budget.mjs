import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";

export const CANVAS_PROJECT_BUDGET = {
    rawBytes: 250 * 1024,
    // The canvas owns placement, naming and export entry points. Image editing,
    // PDF generation and assistant processing remain separate on-demand chunks.
    // Persisted undo/redo, offline-safe tool loading, and inline comparison's
    // source snapshots/entry point add a small entry cost; comparison UI stays lazy.
    // Native copy/paste routing also lives in the entry so HTTP screenshot paste
    // works on the first gesture; reserve 1 KiB for that path, keeping the gate.
    // Immediate undo must flush pending edits in the entry before changing history.
    // Reject oversized imports synchronously at drop/file/paste/reference entry points.
    // Reserve 512 B for the shared limit and immediate user feedback; keep the raw gate.
    gzipBytes: 83 * 1024 + 640,
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
