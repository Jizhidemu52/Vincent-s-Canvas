import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const outputRoot = process.env.CANVAS_ITERATION_OUTPUT || "canvas-agent-iteration";

export default defineConfig({
    testDir: ".", testMatch: "canvas-agent-region-iteration.pw.ts", workers: 1, retries: 0,
    timeout: 90_000, expect: { timeout: 20_000 },
    outputDir: `../../output/${outputRoot}/test-results`,
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, `../../output/${outputRoot}/results.json`) }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5382", viewport: { width: 1800, height: 1200 }, actionTimeout: 15_000, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/canvas-agent-region-iteration.vite.ts --host 127.0.0.1 --port 5382 --strictPort", url: "http://127.0.0.1:5382", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59995", VITE_STANDALONE_EDITION: "false" } },
});
