import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: ".", testMatch: "workbench-simplification.pw.ts", timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/workbench-simplification/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/workbench-simplification/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5343", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
    webServer: { cwd: "..", command: "bun x vite --config e2e/layer-studio-page-vite.config.ts --host 127.0.0.1 --port 5343 --strictPort", url: "http://127.0.0.1:5343", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
