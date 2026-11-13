import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({ testDir: ".", testMatch: "display.pw.ts", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 12000 },
    outputDir: resolve(import.meta.dirname, "../../../output/i18n-complete-20261113/admin-display-browser"),
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../../output/i18n-complete-20261113/admin-display-browser-results.json") }]],
    use: { baseURL: "http://127.0.0.1:5227", viewport: { width: 1280, height: 960 }, serviceWorkers: "block", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, "../.."), command: "node node_modules/vite/bin/vite.js --config tests/admin-display-browser/vite.config.ts", url: "http://127.0.0.1:5227/tests/admin-display-browser/index.html", timeout: 60000, reuseExistingServer: false },
});
