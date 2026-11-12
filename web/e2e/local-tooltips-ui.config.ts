import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "./local-selects-ui.config";

export default defineConfig({
    ...base,
    testMatch: "local-tooltips-ui.pw.ts",
    outputDir: "../../output/ui-plan-20261112/local-tooltips/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/local-tooltips/results.json") }]],
});
