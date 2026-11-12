import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import videoConfig from "./video-seamless-ui-plan.config";

export default defineConfig({
    ...videoConfig,
    testMatch: "all-board-extra.pw.ts",
    grep: /team:|team member|team leader|performance permission/,
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/team-verified/results.json") }]],
    outputDir: "../../output/ui-plan-20261112/team-verified/test-results",
});
