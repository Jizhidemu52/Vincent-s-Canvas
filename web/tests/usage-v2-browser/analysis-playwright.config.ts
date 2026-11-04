import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import report from "./report-playwright.config";
export default defineConfig({
    ...report,
    testMatch: "analysis-v2.pw.ts",
    outputDir: resolve(import.meta.dirname, "../../../output/usage-analysis-browser/test-results"),
});
