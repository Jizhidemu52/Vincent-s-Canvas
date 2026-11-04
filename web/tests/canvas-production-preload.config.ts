import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Serve only the standard build already published in web/dist. This command
// deliberately does not build, use source fixtures, or reuse a running server.
export default defineConfig({
    testDir: resolve(import.meta.dirname, "../e2e"),
    testMatch: "canvas-production-preload.pw.ts",
    timeout: 90_000,
    expect: { timeout: 15_000 },
    workers: 1,
    fullyParallel: false,
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    outputDir: resolve(import.meta.dirname, "../../output/canvas-production-preload/test-results"),
    reporter: [["list"]],
    use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://127.0.0.1:5405",
        viewport: { width: 1600, height: 1000 },
        locale: "zh-CN",
        serviceWorkers: "block",
        actionTimeout: 15_000,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
    },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "node node_modules/vite/bin/vite.js preview --outDir dist --host 127.0.0.1 --port 5405 --strictPort",
        url: "http://127.0.0.1:5405",
        reuseExistingServer: false,
        timeout: 60_000,
        // Defense in depth if an API request ever escapes the browser route.
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" },
    },
});
