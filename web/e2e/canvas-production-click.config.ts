import { defineConfig } from "@playwright/test";
import config from "../playwright.config";
import { resolve } from "node:path";
export default defineConfig({
    ...config,
    testDir: ".", testMatch: "canvas-production-click.pw.ts", reporter: [["list"]],
    outputDir: "../../output/white-screen-production-e2e",
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun x vite preview --outDir ../output/canvas-ux-68d0693-20261027/release-web --host 127.0.0.1 --port 5199 --strictPort",
        url: "http://127.0.0.1:5199", reuseExistingServer: false, timeout: 60000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
