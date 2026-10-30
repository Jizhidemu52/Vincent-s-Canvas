import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "external-image-drop.pw.ts", workers: 1, retries: 0,
    timeout: 45_000, expect: { timeout: 10_000 }, reporter: [["list"]],
    outputDir: "../../output/interaction-experience/external-image-drop/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5304", viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/external-image-drop.vite.ts --host 127.0.0.1 --port 5304 --strictPort", url: "http://127.0.0.1:5304", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
