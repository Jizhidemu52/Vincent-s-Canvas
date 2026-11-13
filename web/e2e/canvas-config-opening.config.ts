import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "canvas-config-opening.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 },
    outputDir: "../../output/canvas-followup-20261113/config-browser",
    reporter: [["list"], ["json", { outputFile: "../../output/canvas-followup-20261113/config-browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5230", viewport: { width: 1680, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/canvas-config-opening.vite.ts --host 127.0.0.1 --port 5230 --strictPort", url: "http://127.0.0.1:5230", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
