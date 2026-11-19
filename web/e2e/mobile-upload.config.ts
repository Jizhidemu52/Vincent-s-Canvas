import { defineConfig } from "@playwright/test";
import base from "./asset-picker-input.config";

export default defineConfig({
    ...base,
    testMatch: "mobile-upload.pw.ts",
    outputDir: "../../output/mobile-upload/test-results",
    use: { ...base.use, baseURL: "http://127.0.0.1:5372", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    webServer: { ...base.webServer, command: "bun x vite --config e2e/asset-picker-input.vite.ts --host 127.0.0.1 --port 5372 --strictPort", url: "http://127.0.0.1:5372" },
});
