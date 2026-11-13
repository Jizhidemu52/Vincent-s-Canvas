import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: ".", testMatch: "i18n.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 },
    outputDir: "../../output/i18n-complete-20261113/root-browser",
    reporter: [["list"], ["json", { outputFile: "../../output/i18n-complete-20261113/root-browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5223", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: "..", command: "bun x vite --config e2e/display-i18n.vite.ts --host 127.0.0.1 --port 5223 --strictPort", url: "http://127.0.0.1:5223", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
