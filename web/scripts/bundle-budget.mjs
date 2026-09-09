import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const CANVAS_PROJECT_BUDGET = {
    rawBytes: 250 * 1024,
    // Adds 512 B for the lazy image-editor entry and durable save/rollback wiring.
    // The editor and raster implementation remain in separate on-demand chunks.
    // Allow 256 B for independent quick-generation submission lifecycle tracking.
    // Allow another 256 B for explicit cursor placement and live Agent viewport metadata.
    gzipBytes: 78 * 1024 + 512,
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

function projectEntries() {
    const assetsDir = resolve(import.meta.dirname, "../dist/assets");
    return readdirSync(assetsDir)
        .filter((name) => /^project-.*\.js$/.test(name))
        .map((name) => {
            const path = resolve(assetsDir, name);
            const content = readFileSync(path);
            return { name, bytes: statSync(path).size, gzipBytes: gzipSync(content).length };
        });
}

if (import.meta.main) {
    const entries = projectEntries();
    if (entries.length !== 1) throw new Error(`Expected exactly one canvas project bundle, found ${entries.length}.`);

    const violations = bundleBudgetViolations(entries);
    if (violations.length) throw new Error(violations.join("\n"));

    const [entry] = entries;
    console.log(`Canvas bundle budget passed: ${entry.name} (${entry.bytes} B raw, ${entry.gzipBytes} B gzip).`);
}
