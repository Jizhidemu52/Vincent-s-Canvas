import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
    testDir: ".", testMatch: "layer-editor.pw.ts", workers: 1, retries: 0, timeout: 45_000,
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/seedream55-integration/editor-tests/results.json") }]],
    outputDir: "../../output/seedream55-integration/editor-tests/browser",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5367", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config tests/layer-editor.vite.ts --host 127.0.0.1 --port 5367 --strictPort", url: "http://127.0.0.1:5367/tests/layer-editor.fixture.html", reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
