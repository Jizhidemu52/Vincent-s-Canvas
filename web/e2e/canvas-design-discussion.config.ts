import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import config from "../playwright.config";
export default defineConfig({ ...config, testDir: ".", testMatch: "canvas-design-discussion.pw.ts", outputDir: "../../output/canvas-design-discussion/results", reporter: [["list"]], use: { ...config.use, baseURL: "http://127.0.0.1:5300" }, webServer: { command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5300 --strictPort", cwd: fileURLToPath(new URL("..", import.meta.url)), url: "http://127.0.0.1:5300", timeout: 60_000, reuseExistingServer: false, env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" } } });
