import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";
export default defineConfig({
    ...base, testDir: "../e2e", testMatch: ["chat-agent-v518.pw.ts", "chat-paste.pw.ts"],
    outputDir: "../../output/chat-agent-v518/browser", reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5337", viewport: { width: 1440, height: 1000 } },
    webServer: { ...base.webServer, cwd: fileURLToPath(new URL("../", import.meta.url)),
        command: "bun x vite --config e2e/chat-agent-v518.vite.ts --host 127.0.0.1 --port 5337 --strictPort", url: "http://127.0.0.1:5337" },
});
