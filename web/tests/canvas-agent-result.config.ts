import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "canvas-agent-result.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 10_000 },
    outputDir: "../../output/canvas-ux-v517/canvas-agent-result-browser/results",
    use: { baseURL: "http://127.0.0.1:5303", viewport: { width: 900, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/canvas-agent-result.vite.ts --host 127.0.0.1 --port 5303 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5303", reuseExistingServer: false, env: { VITE_STANDALONE_EDITION: "false", VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" } },
});
