import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
    testDir: "../e2e", testMatch: ["canvas-edit-lock-v517.pw.ts", "canvas-reliability-cloud-v517.pw.ts", "canvas-library-v517.pw.ts"], workers: 1, retries: 0,
    timeout: 30_000, expect: { timeout: 10_000 },
    outputDir: "../../output/canvas-ux-v517/edit-lock-browser",
    use: { baseURL: "http://127.0.0.1:5207", serviceWorkers: "block", trace: "retain-on-failure" },
    reporter: [["list"]],
    webServer: { command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5207 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5207", reuseExistingServer: false },
});
