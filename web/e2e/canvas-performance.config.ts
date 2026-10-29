import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const variant = process.env.CANVAS_PERF_VARIANT || "candidate";
process.env.CANVAS_PERF_VARIANT = variant;
const port = process.env.CANVAS_PERF_PORT || "5201";
if (!process.env.CANVAS_PERF_DIST) throw new Error("Set CANVAS_PERF_DIST to a production build; development servers are not comparable.");

export default defineConfig({
    testDir: ".", testMatch: "canvas-performance.pw.ts", workers: 1, retries: 0,
    timeout: 240_000, expect: { timeout: 15_000 }, fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    outputDir: `../../output/canvas-performance/${variant}/traces`,
    reporter: [["list"]],
    use: {
        ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`,
        viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1,
        // Trace snapshots/screenshots on every pointer event distort the frame
        // budget. Keep raw timings + product tracker + failure screenshots.
        serviceWorkers: "block", trace: "off", screenshot: "only-on-failure", actionTimeout: 15_000,
        launchOptions: { args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] },
    },
    webServer: {
        command: `bun scripts/canvas-performance-server.mjs`, url: `http://127.0.0.1:${port}`,
        reuseExistingServer: false, timeout: 30_000,
        env: { CANVAS_PERF_DIST: resolve(process.env.CANVAS_PERF_DIST), CANVAS_PERF_PORT: port },
        cwd: resolve(import.meta.dirname, ".."),
    },
});
