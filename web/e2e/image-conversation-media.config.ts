import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "./image-conversations.config";

export default defineConfig({
    ...base,
    testMatch: "image-conversation-media.pw.ts",
    outputDir: "../../output/image-conversation-media-ui/results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/image-conversation-media-ui/report.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5383" },
    webServer: { ...base.webServer, command: "bun x vite --config e2e/canvas-plan-1112.vite.ts --host 127.0.0.1 --port 5383 --strictPort", url: "http://127.0.0.1:5383" },
});
