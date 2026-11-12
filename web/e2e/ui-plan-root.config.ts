import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
    testDir: ".", testMatch: ["interaction-shell.pw.ts", "creative-navigation.pw.ts", "layer-studio-page.pw.ts", "ui-plan-root.pw.ts", "creative-product-target.pw.ts", "creative-local-tools.pw.ts"], workers: 1, retries: 0, timeout: 60_000,
    expect: { timeout: 15_000 }, reporter: [["list"], ["json", { outputFile: "../../output/ui-plan-20261112/root-browser-results.json" }]], outputDir: "../../output/ui-plan-20261112/root-browser",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5204", viewport: { width: 1366, height: 768 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/ui-plan-root.vite.ts --host 127.0.0.1 --port 5204 --strictPort", url: "http://127.0.0.1:5204", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
