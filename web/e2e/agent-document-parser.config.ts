import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: ".", testMatch: "agent-document-parser.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 20_000 }, reporter: [["list"]],
    outputDir: "../../output/agent-document-parser/test-results",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5317", serviceWorkers: "block", screenshot: "only-on-failure" },
    webServer: { cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/agent-document-parser.vite.ts --host 127.0.0.1 --port 5317 --strictPort", url: "http://127.0.0.1:5317/e2e/agent-document-parser.fixture.html", reuseExistingServer: false, timeout: 60_000 },
});
