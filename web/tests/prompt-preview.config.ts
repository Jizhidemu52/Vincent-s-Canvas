import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "prompt-preview.pw.ts", workers: 1, retries: 0, timeout: 60_000, expect: { timeout: 10_000 },
    outputDir: "../../output/prompt-chain-optimization/browser/results",
    use: { baseURL: "http://127.0.0.1:5312", viewport: { width: 1100, height: 850 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/prompt-preview.vite.ts --host 127.0.0.1 --port 5312 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5312", reuseExistingServer: false, env: { VITE_STANDALONE_EDITION: "false", VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" } },
});
