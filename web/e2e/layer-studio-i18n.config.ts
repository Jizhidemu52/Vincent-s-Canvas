import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: ".", testMatch: "layer-studio-i18n.pw.ts", timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/i18n-complete-20261113/layer-studio/browser",
    reporter: [["list"], ["json", { outputFile: "../../output/i18n-complete-20261113/layer-studio/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5222", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: "..", command: "bun x vite --config e2e/layer-studio-i18n.vite.ts --host 127.0.0.1 --port 5222 --strictPort", url: "http://127.0.0.1:5222", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
