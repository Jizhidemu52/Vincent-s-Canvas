import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "design-library.pw.ts", timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/design-library-e2e/test-results", reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5207", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/design-library.vite.ts --host 127.0.0.1 --port 5207 --strictPort", url: "http://127.0.0.1:5207", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
