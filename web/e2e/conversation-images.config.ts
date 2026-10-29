import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import config from "../playwright.config";

export default defineConfig({
    ...config,
    testDir: ".", testMatch: "conversation-images.pw.ts", timeout: 90_000,
    outputDir: "../../output/conversation-images-browser", reporter: [["list"]],
    webServer: { ...config.webServer, cwd: resolve(import.meta.dirname, "..") },
});
