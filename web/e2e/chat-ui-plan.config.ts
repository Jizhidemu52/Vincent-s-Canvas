import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base, testDir: ".", testMatch: ["chat-ui-plan.pw.ts", "chat-agent-iteration.pw.ts", "chat-layout.pw.ts"],
    outputDir: "../../output/ui-plan-20261112/chat/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/chat/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5374", viewport: { width: 1366, height: 768 } },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/chat-ui-plan.vite.ts --host 127.0.0.1 --port 5374 --strictPort", url: "http://127.0.0.1:5374" },
});
