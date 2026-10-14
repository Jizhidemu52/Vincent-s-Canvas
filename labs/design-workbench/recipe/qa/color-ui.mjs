import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await fs.mkdir(directory, { recursive: true });
const origin = new URL(process.env.DESIGN_DEMO_TEST_URL || 'http://127.0.0.1:4328').origin;
const report = { passed: false, checkedAt: new Date().toISOString(), checks: [], pageErrors: [], networkErrors: [], externalRequests: [] };
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
await context.route('**/*', route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('response', response => { if (response.status() >= 400) report.networkErrors.push({ url: response.url(), status: response.status() }); });
const colors = () => page.locator('.recipe-color-chip').evaluateAll(chips => chips.map(chip => chip.style.getPropertyValue('--swatch')));
const check = (name, evidence = {}) => report.checks.push({ name, passed: true, ...evidence });
async function choose(index, hex) { await page.locator(`[data-action="color-select"][data-color-index="${index}"]`).click(); await page.locator('#recipe-color-hex').fill(hex); await page.locator('[data-action="apply-color"]').click(); }
async function download(action, file) { const pending = page.waitForEvent('download'); await page.locator(`[data-action="${action}"]`).click(); const item = await pending; await item.saveAs(path.join(directory, file)); return fs.readFile(path.join(directory, file)); }
try {
  await page.goto(origin + '/demo/recipe', { waitUntil: 'networkidle' });
  await page.locator('#recipe-color-picker').waitFor();
  assert.equal(await page.locator('.recipe-color-chip').count(), 3);
  assert.equal(await page.getByRole('button', { name: '手动选色', exact: true }).getAttribute('aria-pressed'), 'true');
  check('真实页面默认手动选色，三个候选颜色可操作');
  await choose(0, '#FF0000');
  await choose(1, '#00ff00');
  await page.locator('[data-action="color-select"][data-color-index="2"]').click();
  await page.locator('#recipe-color-picker').fill('#0000ff');
  assert.deepEqual(await colors(), ['#ff0000', '#00ff00', '#0000ff']);
  check('HEX 输入与原生选色器真实联动三个颜色');
  await page.locator('#recipe-color-hex').fill('ZZZZZZ');
  await page.locator('[data-action="apply-color"]').click();
  assert.match(await page.locator('[data-palette-status]').innerText(), /请输入有效/);
  assert.deepEqual(await colors(), ['#ff0000', '#00ff00', '#0000ff']);
  check('非法色值显示中文提示且不改变已选颜色');
  await page.locator('[data-action="color-select"][data-color-index="0"]').click();
  await page.locator('[data-action="run"]').click();
  assert.equal(await page.locator('#recipe-color-picker').isDisabled(), true);
  assert.equal(await page.locator('[data-action="color-mode"]').first().isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-node="board"]')?.classList.contains('completed'), {}, { timeout: 20000 });
  const images = await page.locator('.recipe-result-visual img').evaluateAll(async images => {
    const results = [];
    for (const image of images) {
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const data = ctx.getImageData(0, 0, 700, 700).data;
      const dominant = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) if (data[i + channel] > data[i + (channel + 1) % 3] + 45 && data[i + channel] > data[i + (channel + 2) % 3] + 45) dominant[channel]++;
      results.push({ width: image.naturalWidth, height: image.naturalHeight, dominant });
    }
    return results;
  });
  assert.equal(images.length, 3);
  images.forEach((image, index) => assert.ok(image.dominant[index] > 1000, `第 ${index + 1} 张真实像素未使用已选颜色`));
  check('实际候选图分别使用红绿蓝目标色，运行时编辑被禁用', { images });
  await page.screenshot({ path: path.join(directory, 'colors-manual-desktop.png'), fullPage: true });
  const json = JSON.parse((await download('export-json', 'colors-manual-workflow.json')).toString('utf8'));
  assert.deepEqual(json.params.palette.slice(0, 3).map(color => color.hex), ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(json.tasks.filter(task => task.id.startsWith('variant-')).map(task => task.output.color), ['#ff0000', '#00ff00', '#0000ff']);
  assert.equal(json.costs.actual, 0);
  const png = await download('export-board', 'colors-manual-board.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 1800);
  check('真实下载的方案板与流程文件含实际配色，费用仍为零');
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#lab-toast')?.textContent.includes('配方已保存'));
  await choose(0, '#123456');
  assert.equal(await page.locator('.recipe-result-visual img').count(), 0);
  assert.equal(await page.locator('[data-action="export-board"]').isDisabled(), true);
  await page.locator('[data-action="restore"]').click();
  await page.waitForFunction(() => document.querySelector('#lab-toast')?.textContent.includes('已恢复配方'));
  assert.deepEqual(await colors(), ['#ff0000', '#00ff00', '#0000ff']);
  check('修改配色会清除旧结果，保存恢复保留全部自选颜色');
  await page.locator('[data-action="color-mode"][data-mode="random"]').click();
  await page.locator('#recipe-count').selectOption('6');
  const randomStyles = [];
  for (const style of ['soft', 'vivid', 'earth', 'free']) {
    await page.locator('#recipe-palette-style').selectOption(style); const before = await colors();
    await page.locator('[data-action="randomize"]').click(); const after = await colors();
    assert.equal(after.length, 6); assert.equal(new Set(after).size, 6); assert.notDeepEqual(after, before);
    assert.ok(after.every(hex => /^#[0-9a-f]{6}$/.test(hex)));
    randomStyles.push({ style, colors: after });
  }
  check('四种风格和换一组真实产生不同的六色组合', { randomStyles });
  const savedRandom = await colors();
  await page.locator('[data-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#lab-toast')?.textContent.includes('配方已保存'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('[data-action="restore"]').click();
  await page.waitForFunction(() => document.querySelector('#lab-toast')?.textContent.includes('已恢复配方'));
  assert.deepEqual(await colors(), savedRandom);
  assert.equal(await page.locator('#recipe-count').inputValue(), '6');
  assert.equal(await page.locator('#recipe-palette-style').inputValue(), 'free');
  await page.locator('[data-action="color-select"][data-color-index="5"]').click();
  await page.locator('#recipe-count').selectOption('1');
  assert.equal(await page.locator('.recipe-color-chip').count(), 1);
  assert.equal(await page.locator('#recipe-color-picker').inputValue(), savedRandom[0]);
  await page.locator('[data-action="run"]').click();
  await page.waitForFunction(() => document.querySelector('[data-node="board"]')?.classList.contains('completed'), {}, { timeout: 20000 });
  const randomJson = JSON.parse((await download('export-json', 'colors-random-workflow.json')).toString('utf8'));
  assert.equal(randomJson.tasks.find(task => task.id === 'variant-1').output.color, savedRandom[0]);
  check('随机颜色刷新后可恢复，减色数量不越界，随机结果实际参与运行');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#recipe-count').selectOption('6');
  await page.screenshot({ path: path.join(directory, 'colors-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('390 像素窄屏无横向溢出');
  await page.evaluate(async () => {
    const { saveProject } = await import('/shared.js');
    await saveProject('design-studio-recipe-v1', { version: 1, params: { kind: 'structure', count: 3, series: '旧配方兼容', constraints: '保留结构', prompt: '旧版无颜色数据', injectFailure: false }, source: { name: '旧版参考', dataURL: '/assets/garment.png' } });
  });
  await page.locator('[data-action="restore"]').click();
  await page.waitForFunction(() => document.querySelector('#recipe-series')?.value === '旧配方兼容');
  assert.deepEqual(await colors(), ['#91a8a1', '#cfb799', '#b9827b']);
  await page.locator('#recipe-kind').selectOption('pattern');
  assert.equal(await page.locator('#recipe-color-picker').count(), 0);
  check('旧版无配色存档兼容，图案定位流程不显示无关颜色编辑');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.networkErrors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; await page.screenshot({ path: path.join(directory, 'colors-failure.png'), fullPage: true }); }
finally { await fs.writeFile(path.join(directory, 'colors-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); await browser.close(); }
