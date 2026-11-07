import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "asset-picker-input.pw.ts", workers: 1, retries: 0, timeout: 60_000, expect: { timeout: 15_000 }, reporter: [["list"]],
    outputDir: "../../output/asset-picker-input/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5368", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/asset-picker-input.vite.ts --host 127.0.0.1 --port 5368 --strictPort", url: "http://127.0.0.1:5368", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
