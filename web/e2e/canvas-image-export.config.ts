import { defineConfig } from "@playwright/test";
import workspaceConfig from "./personal-workspace.config";

export default defineConfig({ ...workspaceConfig, testMatch: "canvas-image-export.browser.ts", outputDir: "../../output/canvas-image-export-e2e/test-results", use: { ...workspaceConfig.use, actionTimeout: 15_000 } });
