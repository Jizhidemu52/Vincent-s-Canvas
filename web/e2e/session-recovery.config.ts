import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".", testMatch: ["workspace-identity-drain.pw.ts", "interaction-shell.pw.ts"],
    outputDir: "../../output/session-recovery-release/browser", reporter: [["list"]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5291" },
    webServer: { ...base.webServer as object,
        cwd: resolve(import.meta.dirname, ".."),
        command: "bun x vite --config e2e/vite.config.ts --host 127.0.0.1 --port 5291 --strictPort",
        url: "http://127.0.0.1:5291",
    },
});
