import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const variant = process.env.CANVAS_INPUT_VARIANT || "candidate";
const port = "5205";
const dist = resolve(process.env.CANVAS_INPUT_DIST || "../output/canvas-v2-candidate-web");
process.env.CANVAS_INPUT_DIST = dist;
process.env.CANVAS_INPUT_VARIANT = variant;
export default defineConfig({
    testDir: ".", testMatch: "canvas-input-v2.pw.ts", workers: 1, retries: 0,
    timeout: 180_000, expect: { timeout: 15_000 }, forbidOnly: Boolean(process.env.CI),
    outputDir: `../../output/canvas-input-v2/${variant}`, reporter: [["list"]],
    use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1800, height: 1200 }, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure",
        launchOptions: { args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] } },
    webServer: { command: "bun scripts/canvas-performance-server.mjs", url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000,
        cwd: resolve(import.meta.dirname, ".."), env: { CANVAS_PERF_DIST: dist, CANVAS_PERF_PORT: port } },
});
