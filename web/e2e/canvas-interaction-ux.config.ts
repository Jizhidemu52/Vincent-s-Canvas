import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const productionDist = process.env.CANVAS_UX_DIST;

export default defineConfig({
    testDir: ".", testMatch: "canvas-interaction-ux.pw.ts", workers: 1, retries: 0,
    timeout: 60_000, expect: { timeout: 15_000 }, reporter: [["list"]],
    outputDir: "../../output/interaction-ux-canvas",
    use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5204", viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
    webServer: productionDist ? { command: "bun scripts/canvas-performance-server.mjs", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5204", timeout: 30_000, reuseExistingServer: false,
        env: { CANVAS_PERF_DIST: resolve(productionDist), CANVAS_PERF_PORT: "5204" } }
        : { command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5204 --strictPort", cwd: resolve(import.meta.dirname, ".."), url: "http://127.0.0.1:5204", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } },
});
