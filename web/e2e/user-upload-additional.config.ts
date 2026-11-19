import { defineConfig } from "@playwright/test";
import base from "./user-upload-cloud.config";

export default defineConfig({
    ...base, testMatch: ["user-upload-cloud.pw.ts", "series-recipe.pw.ts", "local-workbench-drop.pw.ts"], grep: /additional|retired series|local placement drops|local repeat accepts/,
    outputDir: "../../output/v5101-user-upload/additional-test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/v5101-user-upload/additional-browser-results.json" }]],
});
