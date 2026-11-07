import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";
export default defineConfig({
    ...base, testDir: ".", testMatch: "chat-agent-iteration.pw.ts",
    outputDir: "../../output/chat-agent-iteration/conversational-ui", reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5366", viewport: { width: 1440, height: 1000 } },
    webServer: { ...base.webServer, cwd: fileURLToPath(new URL("../", import.meta.url)), command: "bun x vite --config e2e/chat-agent-iteration.vite.ts --host 127.0.0.1 --port 5366 --strictPort", url: "http://127.0.0.1:5366" },
});
