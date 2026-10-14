import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
await fs.mkdir(path.join(dir, 'qa'), { recursive: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, locale: 'en-US' });
const page = await context.newPage();
const reports = [];
try {
  await page.goto('http://127.0.0.1:4330/', { waitUntil: 'networkidle' });
  for (const name of ['模板', '元素', '文字', '素材', '图层', '我的']) {
    await page.locator('.left-bar .menu-item').filter({ hasText: name }).click();
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    reports.push({ panel: name, visibleText: text, latinTokens: [...new Set(text.match(/[A-Za-z][A-Za-z0-9_.-]*/g) || [])] });
    await page.screenshot({ path: path.join(dir, 'qa', `中文界面-${name}.png`), fullPage: true });
  }
  await page.getByText('中文', { exact: true }).first().hover();
  const languageText = await page.locator('.ivu-select-dropdown:visible').innerText();
  reports.push({ panel: '语言菜单', visibleText: languageText, chineseOnly: !/En|English/.test(languageText) });
  await fs.writeFile(path.join(dir, 'qa', 'chinese-ui-check.json'), JSON.stringify({ browserLocale: 'en-US', title: await page.title(), reports }, null, 2));
  console.log(JSON.stringify(reports.map(({ panel, latinTokens, chineseOnly }) => ({ panel, latinTokens, chineseOnly })), null, 2));
} finally { await browser.close(); }
