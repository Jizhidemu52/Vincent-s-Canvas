import { defineConfig } from "@playwright/test";
import config from "./canvas-interaction-ux.config";

export default defineConfig({ ...config, testMatch: "canvas-alt-copy.pw.ts", timeout: 120_000,
    outputDir: "../../output/canvas-alt-copy", use: { ...config.use, trace: "off" } });
