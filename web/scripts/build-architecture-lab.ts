// Run with Bun from web/: bun scripts/build-architecture-lab.ts [--ui]
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile } from "vite";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(web);
const baseline = "87b282704c733fb1be9a2118baf8d1d92107a854";
const storePath = "web/src/stores/canvas/use-canvas-store.ts";
const allowed = new Set([storePath, "web/src/lib/canvas/canvas-project-storage.ts"]);
const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", "src", "vite.config.ts", "package.json", "bun.lock", "../VERSION"], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
if (changed.some(file => !allowed.has(file))) throw new Error(`Baseline reconstruction requires identical other application sources; unexpected changes: ${changed.filter(file => !allowed.has(file)).join(", ")}`);
const baselineSource = execFileSync("git", ["show", `${baseline}:${storePath}`], { encoding: "utf8" });
const output = resolve(web, "../output/architecture-lab");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(web, "scripts/.architecture-lab-"));
try {
    writeFileSync(join(temporary, "baseline-store.ts"), baselineSource);
    writeFileSync(join(temporary, "entry.ts"), `
import { useCanvasStore, flushCanvasPersistence } from "./baseline-store";
import { localForageStorage } from "../../src/lib/localforage-storage";
Object.assign(window, { architectureLab: { store: useCanvasStore, flush: flushCanvasPersistence,
read: async () => JSON.parse(await localForageStorage.getItem("wireless-canvas:canvas_store") || "null")?.state.projects || [] } });
`);
    execFileSync(process.execPath, ["build", join(temporary, "entry.ts"), "--target", "browser", "--minify", "--outfile", join(output, "baseline.js")], { stdio: "inherit" });
    execFileSync(process.execPath, ["build", "scripts/architecture-lab-entry.ts", "--target", "browser", "--minify", "--outfile", join(output, "candidate.js")], { stdio: "inherit" });
    if (process.argv.includes("--ui")) {
        const loaded = await loadConfigFromFile({ command: "build", mode: "production" });
        if (!loaded) throw new Error("Vite config missing");
        for (const variant of ["baseline", "candidate"]) {
            await build({
                ...loaded.config, configFile: false,
                plugins: [variant === "baseline" ? {
                    name: "architecture-lab-pinned-baseline", enforce: "pre",
                    load(id) { if (id.replaceAll("\\", "/") === resolve(web, "src/stores/canvas/use-canvas-store.ts").replaceAll("\\", "/")) return baselineSource; },
                } : null, ...(loaded.config.plugins || [])],
                build: { ...loaded.config.build, outDir: join(output, variant), emptyOutDir: true },
            });
        }
    }
    console.log(`Architecture lab built against ${baseline}; no main checkout files changed.`);
} finally {
    // This exact directory was returned by mkdtempSync above; it contains only
    // this invocation's two generated source files, never user project files.
    rmSync(temporary, { recursive: true });
}
