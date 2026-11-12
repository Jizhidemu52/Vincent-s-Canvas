import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: ["image-primary-settings.pw.ts", "image-generation-settings-dialog.pw.ts", "image-result-gallery.pw.ts"], workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 }, reporter: [["list"]],
    outputDir: "../../output/ui-plan-20261112/image-primary",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5211", viewport: { width: 1366, height: 768 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: { command: "bun x vite --config e2e/canvas-plan-1112.vite.ts --host 127.0.0.1 --port 5211 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5211", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
