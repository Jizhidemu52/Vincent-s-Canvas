import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(import.meta.dirname, "../../output/user-examples/canvas-browser");
export default defineConfig({
    testDir: "../e2e", testMatch: ["canvas-example.pw.ts", "canvas-onboarding.pw.ts"], timeout: 90_000,
    expect: { timeout: 15_000 }, fullyParallel: false, workers: 1, retries: 0,
    outputDir: resolve(output, "test-results"), reporter: [["list"], ["json", { outputFile: resolve(output, "results.json") }]],
    use: { baseURL: "http://127.0.0.1:5230", viewport: { width: 1366, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        command: "node node_modules/vite/bin/vite.js --config e2e/canvas-example.vite.ts --host 127.0.0.1 --port 5230 --strictPort",
        cwd: fileURLToPath(new URL("../", import.meta.url)), url: "http://127.0.0.1:5230", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59996", VITE_STANDALONE_EDITION: "false" },
    },
});
