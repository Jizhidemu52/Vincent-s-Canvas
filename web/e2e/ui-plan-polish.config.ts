import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "./legacy-ui-contracts.config";

export default defineConfig({
    ...base,
    testMatch: "ui-plan-polish.pw.ts",
    outputDir: "../../output/ui-plan-20261112/polish/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/polish/results.json") }]],
});
