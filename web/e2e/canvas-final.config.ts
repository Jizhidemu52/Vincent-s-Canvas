import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

export default defineConfig({
    ...base, testDir: ".", testMatch: ["canvas-final.pw.ts", "canvas-plan-1112.pw.ts", "canvas-agent-settings-overflow.pw.ts"],
    outputDir: "../../output/ui-plan-final-20261113/canvas/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-final-20261113/canvas/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5222" },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/canvas-final.vite.ts --host 127.0.0.1 --port 5222 --strictPort", url: "http://127.0.0.1:5222" },
});
