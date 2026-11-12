import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base, testDir: ".", testMatch: ["noncanvas-final.pw.ts", "noncanvas-feedback-final.pw.ts", "local-tooltips-ui.pw.ts"],
    outputDir: "../../output/ui-plan-final-20261113/noncanvas/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-final-20261113/noncanvas/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5221" },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/noncanvas-final.vite.ts --host 127.0.0.1 --port 5221 --strictPort", url: "http://127.0.0.1:5221" },
});
