import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
await fs.mkdir(path.join(dir, 'qa'), { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
const page = await context.newPage();
const issues = [];
const blocked = [];
await page.route('**/*', async route => {
  const url = route.request().url();
  if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1:4330/')) { blocked.push(url); await route.abort('blockedbyclient'); } else await route.continue();
});
page.on('pageerror', error => issues.push({ type: 'pageerror', message: error.message }));
page.on('console', message => { if (message.type() === 'error') issues.push({ type: 'console', message: message.text() }); });
try {
  await page.goto('http://127.0.0.1:4330/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.screenshot({ path: path.join(dir, 'qa', '01-original-startup.png'), fullPage: true });
  const result = { text: await page.locator('body').innerText(), issues, blocked, inputs: await page.locator('input').evaluateAll(els => els.map(el => ({ type: el.type, placeholder: el.placeholder, value: el.value }))), vue: await page.evaluate(() => { let component = document.querySelector('.home')?.__vueParentComponent; return { name: component?.type?.name, provides: component ? Object.keys(component.provides) : [], methods: component?.provides?.canvasEditor ? Object.keys(component.provides.canvasEditor) : [] }; }) };
  await fs.writeFile(path.join(dir, 'qa', 'startup-probe.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
