import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "asset-library.pw.ts", timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/asset-library-e2e/test-results", reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5204", viewport: { width: 1600, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, '..'), command: "bun x vite --config e2e/asset-library.vite.ts --host 127.0.0.1 --port 5204 --strictPort", url: "http://127.0.0.1:5204", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
