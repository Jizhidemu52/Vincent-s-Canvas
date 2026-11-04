import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import habits from "./habits-playwright.config";

export default defineConfig({
    ...habits,
    testMatch: "release-context.pw.ts",
    outputDir: resolve(import.meta.dirname, "../../../output/usage-release-context-browser/test-results"),
});
