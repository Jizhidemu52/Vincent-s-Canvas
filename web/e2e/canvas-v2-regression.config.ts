import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import config from "../playwright.config";

// Exercise the delivered production chunks through the public UI. The shared
// fixture rejects unmocked APIs and every external request; no provider runs.
export default defineConfig({
    ...config,
    testDir: ".",
    testMatch: ["canvas-experience.pw.ts", "canvas-regression.pw.ts", "canvas-task-feedback.pw.ts"],
    outputDir: "../../output/canvas-v2-regression",
    reporter: [["list"]],
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun scripts/canvas-performance-server.mjs",
        url: "http://127.0.0.1:5199", reuseExistingServer: false, timeout: 30_000,
        env: { CANVAS_PERF_DIST: resolve(process.env.CANVAS_V2_DIST || "../output/canvas-v2-candidate-web"), CANVAS_PERF_PORT: "5199" },
    },
});
