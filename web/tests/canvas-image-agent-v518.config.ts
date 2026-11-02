import { defineConfig } from "@playwright/test";
import base from "../playwright.config";
import { fileURLToPath } from "node:url";

export default defineConfig({ ...base, testDir: "../e2e", testMatch: "canvas-image-agent-v518.pw.ts",
    outputDir: "../../output/canvas-ux-v517/image-agent-canvas-browser", reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5301" },
    webServer: { ...base.webServer, cwd: fileURLToPath(new URL("../", import.meta.url)),
        command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5301 --strictPort", url: "http://127.0.0.1:5301" },
});
