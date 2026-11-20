import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: "design-discussion-lazy-media.pw.ts",
    outputDir: "../../output/design-discussion-lazy-media/results",
    reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5383", viewport: { width: 1440, height: 1000 } },
    webServer: { ...base.webServer, cwd: fileURLToPath(new URL("..", import.meta.url)), command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5383 --strictPort", url: "http://127.0.0.1:5383" },
});
