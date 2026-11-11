import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import motion from "./video-motion.config";

export default defineConfig(motion, {
    testMatch: ["gemini-omni-video.pw.ts", "video-motion.pw.ts"],
    outputDir: "../../output/admin-errors-20261111/omni-frontend-browser/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/admin-errors-20261111/omni-frontend-browser/results.json") }]],
});
