import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import config from "../playwright.config";

export default defineConfig({
    ...config,
    testDir: ".", testMatch: "i18n.pw.ts", outputDir: "../../output/i18n-browser", reporter: [["list"]],
    webServer: process.env.CANVAS_I18N_DIST ? {
        cwd: resolve(import.meta.dirname, ".."), command: "bun scripts/canvas-performance-server.mjs",
        url: "http://127.0.0.1:5199", reuseExistingServer: false, timeout: 30_000,
        env: { CANVAS_PERF_DIST: resolve(process.env.CANVAS_I18N_DIST), CANVAS_PERF_PORT: "5199" },
    } : { ...config.webServer, cwd: resolve(import.meta.dirname, "..") },
});
