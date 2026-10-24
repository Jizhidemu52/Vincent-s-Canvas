import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "personal-workspace.browser.ts", timeout: 90_000, expect: { timeout: 20_000 }, workers: 1, retries: 0,
    outputDir: "../../output/personal-workspace-e2e/test-results", reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5347", viewport: { width: 1600, height: 1100 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: [
        { cwd: resolve(import.meta.dirname, "../../server"), command: "bun --no-env-file tests/helpers/personal-workspace-server.ts", url: "http://127.0.0.1:5353/api/health", reuseExistingServer: false, timeout: 60_000,
            env: { PGLITE_RUNTIME_PATH: resolve(import.meta.dirname, "../../output/mark-admin-qa/runtime"), WORKSPACE_FIXTURE_PORT: "5353" } },
        { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/personal-workspace.vite.ts --host 127.0.0.1 --port 5347 --strictPort", url: "http://127.0.0.1:5347", reuseExistingServer: false, timeout: 60_000,
            env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:5353", VITE_STANDALONE_EDITION: "false" } },
    ],
});
