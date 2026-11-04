// Offline image-runtime probe; no website, credentials or model is contacted.
const { chromium } = require("playwright");
(async () => {
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
