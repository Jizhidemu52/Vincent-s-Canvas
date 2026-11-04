import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: "../e2e",
    testMatch: "chat-region-composite.pw.ts",
    outputDir: "../../output/chat-region-composite-browser",
    reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5378", viewport: { width: 1440, height: 1000 } },
    webServer: {
        ...base.webServer,
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        // Reuse the existing isolated Vite config, never the live application server.
        command: "bun x vite --config e2e/chat-agent-v518.vite.ts --host 127.0.0.1 --port 5378 --strictPort",
        url: "http://127.0.0.1:5378",
        reuseExistingServer: false,
    },
});
