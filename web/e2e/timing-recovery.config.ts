import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import base from "../playwright.config";

export default defineConfig({
    ...base,
    testDir: ".",
    testMatch: ["image-recovery.pw.ts", "task-events.pw.ts", "workbench-isolation-boundaries.pw.ts"],
    timeout: 90_000,
    outputDir: "../../output/timing-recovery-browser/test-results",
    reporter: [["list"], ["json", { outputFile: resolve(import.meta.dirname, "../../output/timing-recovery-browser/results.json") }]],
    use: { ...base.use, baseURL: "http://127.0.0.1:5369" },
    webServer: {
        ...base.webServer,
        cwd: resolve(import.meta.dirname, ".."),
        command: "node node_modules/vite/bin/vite.js --config e2e/timing-recovery.vite.ts --host 127.0.0.1 --port 5369 --strictPort",
        url: "http://127.0.0.1:5369",
    },
});
