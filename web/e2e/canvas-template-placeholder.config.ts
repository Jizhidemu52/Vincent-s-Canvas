import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["canvas-template-reference.pw.ts", "canvas-template-placeholder.pw.ts"], workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 },
    outputDir: "../../output/canvas-followup-20261113/template-browser",
    reporter: [["list"], ["json", { outputFile: "../../output/canvas-followup-20261113/template-browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5228", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/canvas-template-placeholder.vite.ts --host 127.0.0.1 --port 5228 --strictPort", url: "http://127.0.0.1:5228", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
