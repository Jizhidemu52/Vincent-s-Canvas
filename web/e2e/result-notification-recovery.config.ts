import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["result-notification-recovery.pw.ts", "task-events.pw.ts"],
    timeout: 60_000, expect: { timeout: 20_000 }, workers: 1, retries: 0,
    outputDir: "../../output/result-notification-recovery/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/result-notification-recovery/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5393", viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure", video: "on" },
    webServer: { command: "bun x vite --config e2e/result-notification-recovery.vite.ts --host 127.0.0.1 --port 5393 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5393", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
