import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".",
    testMatch: ["image-new-task-entry.pw.ts", "image-creative-ui-plan.pw.ts", "image-result-gallery.pw.ts", "interaction-shell.pw.ts", "asset-picker-input.pw.ts", "mobile-upload.pw.ts", "generation-ux.pw.ts", "admin-ux.pw.ts", "layer-studio-i18n.pw.ts", "layer-studio-binding.pw.ts"],
    timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: "../../output/headless-legacy-regressions/test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/headless-legacy-regressions/browser-results.json" }]],
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5387", viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure", video: "retain-on-failure" },
    webServer: { command: "bun x vite --config e2e/headless-legacy-regressions.vite.ts --host 127.0.0.1 --port 5387 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5387", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
