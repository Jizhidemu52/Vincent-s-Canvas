import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import videoConfig from "./video-seamless-ui-plan.config";

export default defineConfig({
    ...videoConfig,
    testMatch: "usage-finance-export.pw.ts",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/finance-export-verified/results.json") }]],
    outputDir: "../../output/ui-plan-20261112/finance-export-verified/test-results",
});
