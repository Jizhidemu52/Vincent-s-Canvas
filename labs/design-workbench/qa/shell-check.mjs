import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await fs.mkdir(output, { recursive: true });
const origin = new URL(process.env.DESIGN_DEMO_TEST_URL || 'http://127.0.0.1:4328').origin;
const report = { passed: false, checkedAt: new Date().toISOString(), pages: [], browserErrors: [], blockedExternal: [], httpErrors: [] };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { report.blockedExternal.push(url.origin + url.pathname); return route.abort(); }
    return route.continue();
});
const page = await context.newPage();
page.on('pageerror', error => report.browserErrors.push(error.message));
page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ url: response.url(), status: response.status() }); });
try {
    for (const name of process.argv.length > 2 ? process.argv.slice(2) : ['home', 'placement', 'repeat', 'recipe']) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        const response = await page.goto(origin + (name === 'home' ? '/' : '/demo/' + name));
        assert.equal(response.status(), 200);
        if (name === 'home') assert.equal(await page.locator('.demo-card').count(), 3);
        else if (name === 'recipe') await page.getByRole('button', { name: '模拟运行', exact: true }).waitFor({ timeout: 15000 });
        else {
            await page.locator('#demo canvas').first().waitFor({ timeout: 15000 });
            await page.waitForFunction(() => [...document.querySelectorAll('#demo canvas')].some(canvas => canvas.width > 1));
        }
        await page.screenshot({ path: path.join(output, name + '-desktop.png'), fullPage: true });
        const desktop = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, canvasCount: document.querySelectorAll('canvas').length, buttons: [...document.querySelectorAll('button')].map(button => button.textContent.trim()).filter(Boolean) }));
        assert.ok(desktop.content <= desktop.width + 1, name + ' desktop overflow');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, name + '-mobile.png'), fullPage: true });
        const mobile = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
        assert.ok(mobile.content <= mobile.width + 1, name + ' mobile overflow: ' + mobile.content);
        report.pages.push({ name, desktop, mobile });
    }
    assert.deepEqual(report.browserErrors, []);
    assert.deepEqual(report.blockedExternal, []);
    assert.deepEqual(report.httpErrors, []);
    report.passed = true;
} catch (error) {
    report.error = String(error.stack || error);
    report.failureText = await page.locator('body').innerText();
    await page.screenshot({ path: path.join(output, 'shell-failure.png'), fullPage: true });
    process.exitCode = 1;
} finally {
    await fs.writeFile(path.join(output, 'shell-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    await context.close(); await browser.close();
}
