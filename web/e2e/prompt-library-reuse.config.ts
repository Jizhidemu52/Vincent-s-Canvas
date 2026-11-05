import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "prompt-library-reuse.pw.ts", timeout: 60_000,
    expect: { timeout: 15_000 }, workers: 1, retries: 0,
    outputDir: resolve(import.meta.dirname, "../../output/prompt-library-reuse/test-results"),
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/prompt-library-reuse/results.json") }]],
    use: { baseURL: "http://127.0.0.1:5257", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/prompt-library-reuse.vite.ts --host 127.0.0.1 --port 5257 --strictPort",
        url: "http://127.0.0.1:5257", reuseExistingServer: false, timeout: 60_000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
