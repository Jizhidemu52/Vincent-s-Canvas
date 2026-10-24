import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "prompt-favorites.pw.ts", timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/prompt-favorites-e2e/test-results", reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5205", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/prompt-favorites.vite.ts --host 127.0.0.1 --port 5205 --strictPort", url: "http://127.0.0.1:5205", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
