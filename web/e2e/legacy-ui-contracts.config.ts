import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: ["history-batch-delete.pw.ts", "quick-image-tools.pw.ts", "newarc-image-receiver.pw.ts", "image-recovery.pw.ts", "nonchat-workbench-pressure.pw.ts", "design-examples.pw.ts", "video-output-options.pw.ts", "workbench-navigation-retirement.pw.ts", "admin-prompt-recipes.pw.ts"],
    outputDir: "../../output/ui-plan-20261112/legacy-e2e/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/legacy-e2e/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5213" },
    webServer: { ...base.webServer, cwd: resolve(import.meta.dirname, ".."), command: "node node_modules/vite/bin/vite.js --config e2e/legacy-ui-contracts.vite.ts --host 127.0.0.1 --port 5213 --strictPort", url: "http://127.0.0.1:5213" },
});
