import { defineConfig, devices } from "@playwright/test";

// Deliberately isolated from the running 3000/3100 installation. Every API and
// non-local request is intercepted by the fixture; no provider is contacted.
export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.pw.ts",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    outputDir: "../output/phase1-e2e/test-results",
    reporter: [["list"], ["html", { outputFolder: "../output/phase1-e2e/report", open: "never" }]],
    use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:5199",
        viewport: { width: 1800, height: 1200 },
        serviceWorkers: "block",
        actionTimeout: 15_000,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5199 --strictPort",
        url: "http://127.0.0.1:5199",
        timeout: 60_000,
        reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
