import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["user-upload-cloud.pw.ts"], timeout: 90_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/v5101-user-upload/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/v5101-user-upload/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5397", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", actionTimeout: 15_000, trace: "retain-on-failure", screenshot: "only-on-failure", video: "on" },
    webServer: { command: "bun x vite --config e2e/user-upload-cloud.vite.ts --host 127.0.0.1 --port 5397 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5397", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
