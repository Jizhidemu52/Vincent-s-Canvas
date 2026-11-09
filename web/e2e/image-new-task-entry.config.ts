import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["image-new-task-entry.pw.ts"], workers: 1, retries: 0,
    timeout: 90_000, expect: { timeout: 15_000 },
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/image-new-task-entry-local/results.json") }]],
    outputDir: "../../output/image-new-task-entry-local/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5366", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun node_modules/vite/bin/vite.js --config e2e/image-new-task-entry.vite.ts --host 127.0.0.1 --port 5366 --strictPort",
        url: "http://127.0.0.1:5366", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
