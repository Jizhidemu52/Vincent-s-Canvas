import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".",
    testMatch: ["creative-local-tools.pw.ts", "final-four-ui-i18n.pw.ts", "image-primary-settings.pw.ts", "mai27-model-settings.pw.ts"],
    workers: 1, retries: 0, timeout: 60_000,
    expect: { timeout: 15_000 }, reporter: [["list"]], outputDir: "../../output/headless-settings-local-tools/browser",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5389", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure", video: "on" },
    webServer: { command: "bun x vite --config e2e/headless-settings-local-tools.vite.ts --host 127.0.0.1 --port 5389 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5389", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
