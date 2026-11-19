import { defineConfig } from "@playwright/test";
import base from "./user-upload-cloud.config";

export default defineConfig({
    ...base, testMatch: ["mobile-upload.pw.ts"],
    outputDir: "../../output/v5101-user-upload/mobile-test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/v5101-user-upload/mobile-results.json" }]],
});
