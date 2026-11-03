import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(import.meta.dirname, "../../output/image-agent-validation/streaming-dom-acceptance");

export default defineConfig({
    testDir: "../e2e",
    testMatch: "image-agent-streaming-dom.pw.ts",
    timeout: 90_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    outputDir: resolve(output, "test-results"),
    reporter: [["list"], ["json", { outputFile: resolve(output, "playwright-results.json") }]],
    use: { baseURL: "http://127.0.0.1:5298", viewport: { width: 1600, height: 1100 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        command: "node node_modules/vite/bin/vite.js --config e2e/image-agent-streaming-dom.vite.ts --host 127.0.0.1 --port 5298 --strictPort",
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        url: "http://127.0.0.1:5298",
        timeout: 60_000,
        reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59887", VITE_STANDALONE_EDITION: "false" },
    },
});
