import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["workbench-multitask.pw.ts", "workbench-creative-boundaries.pw.ts", "recipe-read-boundaries.pw.ts"], workers: 1, retries: 0, timeout: 90_000, expect: { timeout: 15_000 }, reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/workbench-multitask/results.json") }]],
    outputDir: "../../output/workbench-multitask/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5355", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/workbench-multitask.vite.ts --host 127.0.0.1 --port 5355 --strictPort", url: "http://127.0.0.1:5355", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
