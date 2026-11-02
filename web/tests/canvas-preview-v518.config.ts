import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "canvas-preview-v518.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 8000 },
    outputDir: "../../output/canvas-ux-v517/cloud-preview-browser/results",
    use: { baseURL: "http://127.0.0.1:5298", viewport: { width: 1200, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/canvas-preview-v518.vite.ts --host 127.0.0.1 --port 5298 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5298", reuseExistingServer: false, env: { VITE_STANDALONE_EDITION: "false", VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" } },
});
