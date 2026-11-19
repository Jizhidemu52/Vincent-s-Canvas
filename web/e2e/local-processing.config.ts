import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base, testDir: ".", testMatch: ["local-processing.pw.ts", "creative-local-tools.pw.ts", "account-history-final.pw.ts"],
    outputDir: "../../output/v5101-local-processing/frontend-browser",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/v5101-local-processing/frontend-browser-results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5398", video: "retain-on-failure" },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/local-processing.vite.ts --host 127.0.0.1 --port 5398 --strictPort", url: "http://127.0.0.1:5398" },
});
