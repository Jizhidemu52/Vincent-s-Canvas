// Offline image-runtime probe; no website, credentials or model is contacted.
const { chromium } = require("playwright");
const { spawnSync } = require("node:child_process");
const { dirname, resolve } = require("node:path");
(async () => {
    // Loading the real suite catches missing ESM/package metadata that a bare
    // Chromium launch cannot detect. --list executes no test or website call.
    const discovered = spawnSync(process.execPath, [
        resolve(dirname(require.resolve("@playwright/test/package.json")), "cli.js"),
        "test", "--config", resolve(__dirname, "web/e2e/production-smoke.config.ts"), "--list",
    ], {
        encoding: "utf8", timeout: 30_000, windowsHide: true,
        env: { ...process.env,
            CANVAS_SMOKE_MODE: "staging", CANVAS_SMOKE_COMMIT: "0".repeat(40),
            CANVAS_SMOKE_PROJECT: "canvas-staging-000000000000-000000000000",
            CANVAS_SMOKE_BASE_URL: "http://127.0.0.1:18080",
            CANVAS_SMOKE_OUTPUT_DIR: resolve(require("node:os").tmpdir(), "canvas-stage-runner-discovery"),
        },
    });
    if (discovered.error || discovered.status !== 0 || !/Total: 1 test in 1 file/.test(discovered.stdout)) {
        throw new Error("Packaged smoke suite discovery failed: " + (discovered.stderr || discovered.stdout || discovered.error?.message));
    }
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ serviceWorkers: "block" });
        await context.route("**/*", route => route.abort("blockedbyclient"));
        const page = await context.newPage();
        await page.setContent("<h1>Isolated stage browser is ready</h1>");
        if (await page.locator("h1").textContent() !== "Isolated stage browser is ready") throw new Error("Browser DOM probe failed");
        console.log(JSON.stringify({ schema: 1, kind: "canvas-stage-browser-runtime", status: "passed", browser: browser.version(), paid: false }));
    } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
