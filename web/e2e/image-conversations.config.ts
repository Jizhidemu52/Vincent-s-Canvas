import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "image-conversations.pw.ts", workers: 1, retries: 0, timeout: 60_000,
    expect: { timeout: 15_000 }, reporter: [["list"]], outputDir: "../../output/image-conversations-ui/playwright",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5379", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { command: "bun x vite --config e2e/canvas-plan-1112.vite.ts --host 127.0.0.1 --port 5379 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5379", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
