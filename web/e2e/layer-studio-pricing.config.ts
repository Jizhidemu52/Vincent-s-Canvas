import { defineConfig } from "@playwright/test";
import pageConfig from "./layer-studio-page.config";

export default defineConfig({ ...pageConfig, testMatch: "layer-studio-pricing.pw.ts",
    outputDir: "../../output/seedream55-integration/pricing-test-results",
    reporter: [["list"], ["json", { outputFile: "../../output/seedream55-integration/pricing-browser-results.json" }]],
});
