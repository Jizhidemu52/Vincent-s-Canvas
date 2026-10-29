import { defineConfig } from "@playwright/test";
import config from "../playwright.config";
import { resolve } from "node:path";
const production = process.env.CANVAS_IMAGE_WORKER_PREVIEW === "1";
const productionDist = resolve(process.env.CANVAS_IMAGE_WORKER_DIST || "../output/canvas-v2-image-worker-release");

export default defineConfig({
    ...config,
    testDir: ".", testMatch: "image-worker-v2.pw.ts", reporter: [["list"]],
    outputDir: production ? "../../output/canvas-v2-image-worker-production" : "../../output/canvas-v2-image-worker/test-results",
    use: { ...config.use, baseURL: "http://127.0.0.1:5202" },
    webServer: {
        cwd: resolve(import.meta.dirname, ".."),
        command: production ? `bun x vite preview --outDir "${productionDist}" --host 127.0.0.1 --port 5202 --strictPort` : "bun x vite --config e2e/image-worker-v2.vite.ts --host 127.0.0.1 --port 5202 --strictPort",
        url: "http://127.0.0.1:5202", reuseExistingServer: false, timeout: 60000,
        env: { VITE_API_PROXY_TARGET: "http://127.0.0.1:59999", VITE_STANDALONE_EDITION: "false" },
    },
});
