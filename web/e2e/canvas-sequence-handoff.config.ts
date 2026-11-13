import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["canvas-sequence-handoff.pw.ts"], workers: 1, retries: 0,
    timeout: 100_000, expect: { timeout: 20_000 },
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/canvas-sequence-handoff/results.json") }]],
    outputDir: "../../output/canvas-sequence-handoff/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5229", viewport: { width: 1800, height: 1200 }, actionTimeout: 15_000, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "node node_modules/vite/bin/vite.js --config e2e/canvas-sequence-handoff.vite.ts --host 127.0.0.1 --port 5229 --strictPort",
        url: "http://127.0.0.1:5229", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
