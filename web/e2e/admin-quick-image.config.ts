import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".",
    testMatch: "admin-quick-image.pw.ts",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    workers: 1,
    retries: 0,
    outputDir: "../../output/paid-regression-20261106/admin-quick-image-browser",
    reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5412", viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun x vite --config e2e/admin-quick-image.vite.ts --host 127.0.0.1 --port 5412 --strictPort",
        url: "http://127.0.0.1:5412",
        reuseExistingServer: false,
        timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
