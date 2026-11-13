import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import promptConfig from "./general-prompts-i18n-browser.config";

export default defineConfig({
    ...promptConfig,
    testMatch: "dynamic-content-i18n.pw.ts",
    outputDir: resolve(import.meta.dirname, "../../output/i18n-complete-20261113/dynamic-browser"),
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/i18n-complete-20261113/dynamic-browser-results.json") }]],
});
