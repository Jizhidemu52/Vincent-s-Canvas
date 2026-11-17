import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import config from "../playwright.config";

export default defineConfig({
    ...config,
    testDir: ".",
    testMatch: "canvas-creation-count.pw.ts",
    outputDir: "../../output/canvas-creation-count/results",
    reporter: [["list"]],
    use: { ...config.use, baseURL: "http://127.0.0.1:5298" },
    webServer: {
        command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5298 --strictPort",
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        url: "http://127.0.0.1:5298", timeout: 60_000, reuseExistingServer: false,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
