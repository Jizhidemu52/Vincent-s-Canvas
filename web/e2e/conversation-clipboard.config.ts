import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: "conversation-clipboard.pw.ts",
    outputDir: "../../output/conversation-clipboard-browser/results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/conversation-clipboard-browser/report.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5368", viewport: { width: 1440, height: 1000 } },
    webServer: {
        ...base.webServer,
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun x vite --config e2e/conversation-clipboard.vite.ts --host 127.0.0.1 --port 5368 --strictPort",
        url: "http://127.0.0.1:5368",
    },
});
