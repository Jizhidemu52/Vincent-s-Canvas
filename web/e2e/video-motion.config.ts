import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["video-motion.pw.ts", "design-examples.pw.ts"], workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 },
    outputDir: "../../output/video-motion-browser/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/video-motion-browser/results.json") }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5358", viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/video-motion.vite.ts --host 127.0.0.1 --port 5358 --strictPort", url: "http://127.0.0.1:5358", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59995", VITE_STANDALONE_EDITION: "false" } },
});
