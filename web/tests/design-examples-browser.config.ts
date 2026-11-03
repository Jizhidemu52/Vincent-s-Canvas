import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = resolve(import.meta.dirname, "../../output/design-examples-validation");
export default defineConfig({
    testDir: "../e2e", testMatch: "design-examples.pw.ts", timeout: 75_000,
    expect: { timeout: 15_000 }, fullyParallel: false, workers: 1, retries: 0,
    outputDir: resolve(output, "test-results"), reporter: [["list"], ["json", { outputFile: resolve(output, "results.json") }]],
    use: { baseURL: "http://127.0.0.1:5352", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: {
        command: "node node_modules/vite/bin/vite.js --config e2e/design-examples.vite.ts --host 127.0.0.1 --port 5352 --strictPort",
        cwd: fileURLToPath(new URL("../", import.meta.url)), url: "http://127.0.0.1:5352", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59997", VITE_STANDALONE_EDITION: "false" },
    },
});
