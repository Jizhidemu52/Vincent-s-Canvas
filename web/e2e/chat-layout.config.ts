import { defineConfig } from "@playwright/test";
import base from "../playwright.config";
import { resolve } from "node:path";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: ["chat-layout.pw.ts", "canvas-agent-result.pw.ts"],
    outputDir: "../../output/chat-layout-browser/results",
    reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5367", viewport: { width: 1440, height: 1000 } },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "bun x vite --config e2e/chat-layout.vite.ts --host 127.0.0.1 --port 5367 --strictPort", url: "http://127.0.0.1:5367" },
});
