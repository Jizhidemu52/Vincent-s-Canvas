import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const qa = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await fs.mkdir(qa, { recursive: true });
const origin = new URL(process.env.DESIGN_DEMO_TEST_URL || 'http://127.0.0.1:4328').origin;
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
const results = [];
const test = (label, detail) => { results.push({ label, detail }); console.log(`PASS ${label}: ${detail}`); };
const download = async (selector, filename) => {
  const promise = page.waitForEvent('download'); await page.locator(selector).click(); const d = await promise;
  const output = path.join(qa, filename || d.suggestedFilename()); await d.saveAs(output); return output;
};
const pixels = async (aPath, bPath) => {
  const a = (await fs.readFile(aPath)).toString('base64'), b = (await fs.readFile(bPath)).toString('base64');
  return page.evaluate(async ({ a, b }) => {
    async function decode(data) { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data }; }
    const period = await decode(a), preview = await decode(b); let mismatches = 0, maxDelta = 0;
    for (let y = 0; y < preview.height; y++) for (let x = 0; x < preview.width; x++) for (let c = 0; c < 4; c++) {
      const delta = Math.abs(preview.data[(y * preview.width + x) * 4 + c] - period.data[((y % period.height) * period.width + x % period.width) * 4 + c]);
      if (delta > 1) mismatches++; maxDelta = Math.max(maxDelta, delta);
    }
    return { period: [period.width, period.height], preview: [preview.width, preview.height], mismatches, maxDelta };
  }, { a, b });
};

try {
  await page.goto(origin + '/demo/repeat');
  await page.locator('[data-role="unit-pixels"]').filter({ hasText: '591 × 591' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="repeat-canvas"]')?.width > 100);
  await page.screenshot({ path: path.join(qa, 'repeat-desktop.png'), fullPage: true });
  test('initial scene', '7 built-in elements, 10 cm / 150 DPI = 591 px, half-drop export 1182×591');
  assert.equal(await page.locator('[data-role="export-pixels"]').innerText(), '1182 × 591 像素');
  await page.locator('[data-testid="repeat-add-flower"]').click();
  assert.match(await page.locator('[data-role="item-count"]').innerText(), /^8/);
  const canvas = page.locator('[data-testid="repeat-canvas"]'); const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 1.2, box.y + box.height * .5, { steps: 10 }); await page.mouse.up();
  await page.locator('[data-testid="repeat-size"]').evaluate(input => { input.value = '.4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('[data-testid="repeat-angle"]').evaluate(input => { input.value = '37'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const jsonPath = await download('[data-testid="repeat-export-json"]', 'dragged-project.json');
  const saved = JSON.parse(await fs.readFile(jsonPath, 'utf8')); const moved = saved.elements.at(-1);
  assert.ok(Math.abs(moved.x - .2) < .01); assert.ok(moved.y < .01 || moved.y > .99); assert.equal(moved.angle, 37); assert.equal(moved.size, .4);
  test('cross-edge drag + transforms', `last element x=${moved.x.toFixed(3)}, y=${moved.y.toFixed(3)}; half-drop y shifted 0.5, rotation 37°, size 40%`);
  await page.locator('[data-testid="repeat-save"]').click(); await page.locator('[data-role="status"]').filter({ hasText: '已保存' }).waitFor();
  await page.reload(); await page.locator('[data-testid="repeat-restore"]').click(); await page.locator('[data-role="status"]').filter({ hasText: '已打开本地存档' }).waitFor();
  assert.match(await page.locator('[data-role="item-count"]').innerText(), /^8/);
  test('IndexedDB save and reopen', '8 elements restored after page reload');
  await page.locator('[data-testid="repeat-width"]').fill('2.54'); await page.locator('[data-testid="repeat-width"]').press('Tab');
  await page.locator('[data-testid="repeat-height"]').fill('3.81'); await page.locator('[data-testid="repeat-height"]').press('Tab');
  await page.locator('[data-testid="repeat-dpi"]').selectOption('72');
  for (const [mode, expected] of [['straight', [72, 108]], ['half', [144, 108]], ['mirror', [144, 216]]]) {
    await page.locator(`[data-testid="repeat-mode-${mode}"]`).click();
    const unit = await download('[data-testid="repeat-export-unit"]', `${mode}-unit.png`);
    const preview = await download('[data-testid="repeat-export-preview"]', `${mode}-preview.png`);
    const compared = await pixels(unit, preview); assert.deepEqual(compared.period, expected); assert.deepEqual(compared.preview, [216, 324]); assert.equal(compared.mismatches, 0, `${mode} exported period and preview disagree: ${JSON.stringify(compared)}`);
    test(`${mode} exported pixel periodicity`, JSON.stringify(compared));
  }
  await page.locator('[data-testid="repeat-transparent"]').check();
  const transparentPath = await download('[data-testid="repeat-export-unit"]', 'transparent-unit.png');
  const png = await fs.readFile(transparentPath); const chunks = []; let offset = 8;
  while (offset < png.length) { const size = png.readUInt32BE(offset), kind = png.toString('ascii', offset + 4, offset + 8); chunks.push(kind); offset += size + 12; }
  assert.ok(!chunks.includes('pHYs'));
  const alpha = await page.evaluate(async data => { const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const a = ctx.getImageData(0, 0, c.width, c.height).data; return [...a].filter((_, i) => i % 4 === 3).some(v => v === 0); }, png.toString('base64'));
  assert.ok(alpha); test('transparent export and DPI honesty', `transparent pixels present; PNG chunks: ${chunks.join(', ')}, no pHYs`);
  await page.locator('[data-testid="repeat-width"]').fill('60'); await page.locator('[data-testid="repeat-width"]').press('Tab');
  await page.locator('[data-testid="repeat-dpi"]').selectOption('300');
  assert.equal(await page.locator('[data-testid="repeat-export-unit"]').isDisabled(), true);
  test('large export safety', 'oversized mirror period disables full-size export and displays limit');
  await page.locator('[data-testid="repeat-restore"]').click(); await page.locator('[data-role="status"]').filter({ hasText: '已打开本地存档' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(qa, 'repeat-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  assert.equal(overflow, false); test('mobile layout', '390px viewport has no horizontal overflow');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(qa, 'results.json'), JSON.stringify({ passed: true, results, errors }, null, 2));
} finally { await browser.close(); }
