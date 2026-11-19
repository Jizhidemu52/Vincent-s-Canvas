import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".",
    testMatch: ["video-new-task-entry.pw.ts", "video-seamless-ui-plan.pw.ts", "prompt-url-handoff.pw.ts", "workbench-isolation-boundaries.pw.ts"],
    timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/headless-root-regressions/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/headless-root-regressions/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5391", viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { command: "bun x vite --config e2e/headless-root-regressions.vite.ts --host 127.0.0.1 --port 5391 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5391", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
