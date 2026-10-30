import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "interaction-shell.pw.ts", workers: 1, retries: 0, timeout: 60_000,
    expect: { timeout: 15_000 }, reporter: [["list"]], outputDir: "../../output/interaction-experience/shell/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5288", viewport: { width: 1440, height: 900 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/interaction-shell.vite.ts --host 127.0.0.1 --port 5288 --strictPort", url: "http://127.0.0.1:5288", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
