import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base, testDir: ".", testMatch: ["account-history-final.pw.ts", "image-generation-settings-dialog.pw.ts", "ui-plan-root.pw.ts"],
    outputDir: "../../output/ui-plan-final-20261113/account-history/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-final-20261113/account-history/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5220" },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/account-history-final.vite.ts --host 127.0.0.1 --port 5220 --strictPort", url: "http://127.0.0.1:5220" },
});
