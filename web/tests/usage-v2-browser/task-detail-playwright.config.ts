import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import report from "./report-playwright.config";
export default defineConfig({
    ...report,
    testMatch: "task-detail.pw.ts",
    outputDir: resolve(import.meta.dirname, "../../../output/usage-task-detail-browser/test-results"),
});
