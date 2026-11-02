import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "image-agent-focus.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 10_000 },
    outputDir: "../../output/canvas-ux-v517/image-agent-focus-browser/results",
    use: { baseURL: "http://127.0.0.1:5302", viewport: { width: 1000, height: 850 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/image-agent-focus.vite.ts --host 127.0.0.1 --port 5302 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5302", reuseExistingServer: false, env: { VITE_STANDALONE_EDITION: "false", VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" } },
});
