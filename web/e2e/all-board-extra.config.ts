import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "all-board-extra.pw.ts", workers: 1, retries: 0,
    timeout: 90_000, expect: { timeout: 20_000 },
    outputDir: "../../output/all-board-extra-qa/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/all-board-extra-qa/results.json") }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5369", viewport: { width: 1600, height: 1100 }, actionTimeout: 15_000,
        serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/all-board-extra.vite.ts --host 127.0.0.1 --port 5369 --strictPort",
        url: "http://127.0.0.1:5369", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59995", VITE_STANDALONE_EDITION: "false" } },
});
