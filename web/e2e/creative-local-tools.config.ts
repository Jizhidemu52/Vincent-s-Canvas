import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "creative-local-tools.pw.ts", workers: 1, retries: 0,
    timeout: 90_000, expect: { timeout: 20_000 },
    outputDir: "../../output/creative-local-tools-qa/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/creative-local-tools-qa/results.json") }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5357", viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, serviceWorkers: "block", acceptDownloads: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/creative-local-tools.vite.ts --host 127.0.0.1 --port 5357 --strictPort", url: "http://127.0.0.1:5357", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59995", VITE_STANDALONE_EDITION: "false" } },
});
