import { defineConfig, devices } from "@playwright/test";
import { isAbsolute, resolve } from "node:path";
import { assertSmokeProject } from "../../server/tests/production-smoke/identity";

const address = new URL(process.env.CANVAS_SMOKE_BASE_URL || "invalid:");
const output = process.env.CANVAS_SMOKE_OUTPUT_DIR || "";
if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || !address.port
    || address.username || address.password || address.pathname !== "/" || address.search || address.hash
    || !isAbsolute(output)) {
    throw new Error("Production smoke requires the explicit isolated Compose stack; no default/demo server is started");
}
assertSmokeProject(process.env);

export default defineConfig({
    testDir: ".", testMatch: "production-smoke.browser.ts", timeout: 240_000,
    expect: { timeout: 30_000 }, workers: 1, fullyParallel: false, retries: 0,
    reporter: [["list"]], outputDir: resolve(output, "browser-private"),
    use: {
        ...devices["Desktop Chrome"], baseURL: address.origin,
        viewport: { width: 1600, height: 1100 }, locale: "zh-CN", timezoneId: "Asia/Shanghai",
        serviceWorkers: "block", acceptDownloads: true,
        // Login requests contain disposable passwords. Do not retain network
        // traces/HARs or videos that could accidentally enter public artifacts.
        trace: "off", video: "off", screenshot: "only-on-failure",
    },
});
