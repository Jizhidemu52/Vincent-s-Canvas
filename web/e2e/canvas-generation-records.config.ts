import { defineConfig } from "@playwright/test";
import config from "./canvas-interaction-ux.config";

const server = config.webServer as Exclude<typeof config.webServer, unknown[]>;
export default defineConfig({
    ...config,
    testMatch: "canvas-generation-records.pw.ts",
    timeout: 90_000,
    outputDir: "../../output/canvas-records-e2e/results",
    use: { ...config.use, baseURL: "http://127.0.0.1:5208" },
    webServer: { ...server, command: server!.command.replace("--port 5204", "--port 5208"),
        url: "http://127.0.0.1:5208", env: { ...server!.env, CANVAS_PERF_PORT: "5208" } },
});
