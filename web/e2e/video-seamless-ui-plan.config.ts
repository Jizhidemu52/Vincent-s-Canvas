import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["video-seamless-ui-plan.pw.ts", "video-new-task-entry.pw.ts", "seamless-preview.pw.ts"],
    workers: 1, retries: 0, timeout: 90_000, expect: { timeout: 15_000 },
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/video-seamless/results.json") }]],
    outputDir: "../../output/ui-plan-20261112/video-seamless/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5203", viewport: { width: 1366, height: 768 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "node node_modules/vite/bin/vite.js --config e2e/video-seamless-ui-plan.vite.ts --host 127.0.0.1 --port 5203 --strictPort",
        url: "http://127.0.0.1:5203", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
