import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "canvas-generation-v517.pw.ts", workers: 1, retries: 0,
    timeout: 45_000, expect: { timeout: 12_000 },
    outputDir: "../../output/canvas-ux-v517/generation-browser/results",
    use: { baseURL: "http://127.0.0.1:5291", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/canvas-generation-v517.vite.ts --host 127.0.0.1 --port 5291 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5291", reuseExistingServer: false, env: { VITE_STANDALONE_EDITION: "true", VITE_API_PROXY_TARGET: "http://127.0.0.1:59999" } },
});
