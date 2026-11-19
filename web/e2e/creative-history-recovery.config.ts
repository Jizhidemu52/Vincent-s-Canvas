import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["creative-history-recovery.pw.ts", "creative-reconciliation.pw.ts"],
    timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/creative-history-recovery/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/creative-history-recovery/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5395", viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure", video: "on" },
    webServer: { command: "bun x vite --config e2e/creative-history-recovery.vite.ts --host 127.0.0.1 --port 5395 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5395", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
