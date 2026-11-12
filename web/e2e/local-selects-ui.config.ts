import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: ["local-selects-ui.pw.ts", "pattern-repeat-export.pw.ts", "pattern-repeat-responsive.pw.ts", "local-workbench-drop.pw.ts"],
    outputDir: "../../output/ui-plan-20261112/local/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/local/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5213", viewport: { width: 1366, height: 900 } },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/local-selects-ui.vite.ts --host 127.0.0.1 --port 5213 --strictPort", url: "http://127.0.0.1:5213" },
});
