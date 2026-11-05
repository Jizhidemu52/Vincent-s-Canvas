import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "canvas-eraser.pw.ts", workers: 1, retries: 0, timeout: 60_000, expect: { timeout: 15_000 }, reporter: [["list"]],
    outputDir: "../../output/canvas-eraser/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5325", viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/canvas-eraser.vite.ts --host 127.0.0.1 --port 5325 --strictPort", url: "http://127.0.0.1:5325", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
