import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "./legacy-ui-contracts.config";

export default defineConfig({
    ...base,
    testMatch: "ui-inline-feedback.pw.ts",
    outputDir: "../../output/ui-plan-20261112/inline-feedback/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/inline-feedback/results.json") }]],
});
