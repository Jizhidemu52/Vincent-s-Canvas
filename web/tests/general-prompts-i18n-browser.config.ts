import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: "general-prompts-i18n.pw.ts", timeout: 90_000,
    expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: resolve(import.meta.dirname, "../../output/i18n-complete-20261113/prompt-browser"),
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/i18n-complete-20261113/prompt-browser-results.json") }]],
    use: { baseURL: "http://127.0.0.1:5221", viewport: { width: 1366, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "node node_modules/vite/bin/vite.js --config e2e/general-prompts-i18n.vite.ts --host 127.0.0.1 --port 5221 --strictPort",
        url: "http://127.0.0.1:5221", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59996", VITE_STANDALONE_EDITION: "false" },
    },
});
