import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import videoConfig from "./video-seamless-ui-plan.config";

export default defineConfig({
    ...videoConfig,
    testMatch: ["gpt26-model-parameters.pw.ts", "image-generation-settings-dialog.pw.ts", "mai-model-adaptation.pw.ts", "prompt-url-handoff.pw.ts", "image-workspace-defaults.pw.ts", "i18n.pw.ts"],
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/ui-plan-20261112/shared-image-settings/results.json") }]],
    outputDir: "../../output/ui-plan-20261112/shared-image-settings/test-results",
});
