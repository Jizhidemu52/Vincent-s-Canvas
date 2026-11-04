import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: "compilation.pw.ts", timeout: 90000, expect: { timeout: 15000 }, workers: 1, retries: 0,
    outputDir: resolve(import.meta.dirname, "../../../output/usage-compilation-browser/test-results"), reporter: [["list"]],
    use: { baseURL: "http://127.0.0.1:5403", viewport: { width: 1440, height: 1050 }, serviceWorkers: "block", screenshot: "only-on-failure", actionTimeout: 15000 },
    webServer: { command: "node node_modules/vite/bin/vite.js --config tests/usage-v2-browser/compilation-vite.config.ts", cwd: resolve(import.meta.dirname, "../.."), url: "http://127.0.0.1:5403/tests/usage-v2-browser/index.html", reuseExistingServer: false, timeout: 60000 },
});
