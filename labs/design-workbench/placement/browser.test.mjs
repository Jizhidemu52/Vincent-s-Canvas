import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const qa = path.join(directory, 'qa', 'output');
const origin = new URL(process.env.DESIGN_DEMO_TEST_URL || 'http://127.0.0.1:4328').origin;
await fs.mkdir(qa, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1120 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const completed = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const button = name => page.getByRole('button', { name, exact: true });
const number = name => page.getByRole('spinbutton', { name, exact: true });
const layerCount = () => page.locator('.placement-layer').count();
async function download(name, file) {
  const pending = page.waitForEvent('download');
  await button(name).click();
  const result = await pending;
  await result.saveAs(path.join(qa, file));
  return path.join(qa, file);
}
async function setNumber(name, value) {
  await number(name).fill(String(value));
  await number(name).press('Tab');
}
try {
  await page.goto(origin + '/demo/placement');
  await page.getByRole('button', { name: '胸前花朵', exact: true }).waitFor();
  assert.equal(await layerCount(), 1);
  assert.match(await page.locator('.placement-status').textContent(), /人工智能褶皱融合未连接/);
  await page.screenshot({ path: path.join(qa, '01-desktop-default.png'), fullPage: true });
  completed.push('default composition and boundary notice');

  const oldWidth = Number(await number('图案宽度').inputValue());
  await setNumber('图案宽度', 300);
  assert.equal(Number(await number('图案宽度').inputValue()), 300);
  await button('撤销').click();
  assert.equal(Number(await number('图案宽度').inputValue()), oldWidth);
  await button('重做').click();
  assert.equal(Number(await number('图案宽度').inputValue()), 300);
  completed.push('numeric controls and undo/redo');

  const canvas = page.locator('canvas');
  const bounds = await canvas.boundingBox();
  const natural = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
  const x = Number(await number('横向 X').inputValue());
  const y = Number(await number('纵向 Y').inputValue());
  const px = bounds.x + x * bounds.width / natural.width;
  const py = bounds.y + y * bounds.height / natural.height;
  await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px + 35, py + 20, { steps: 5 }); await page.mouse.up();
  assert.ok(Math.abs(Number(await number('横向 X').inputValue()) - (x + 35 * natural.width / bounds.width)) < .3);
  assert.ok(Math.abs(Number(await number('纵向 Y').inputValue()) - (y + 20 * natural.height / bounds.height)) < .3);
  await canvas.focus(); await page.keyboard.press('Shift+ArrowRight');
  assert.ok(Math.abs(Number(await number('横向 X').inputValue()) - (x + 35 * natural.width / bounds.width + 10)) < .3);
  completed.push('CSS-scaled pointer drag and keyboard nudge');

  await page.getByRole('button', { name: '添加枝叶图案', exact: true }).click();
  await page.getByRole('button', { name: '枝叶图案', exact: true }).waitFor();
  assert.equal(await layerCount(), 2);
  await button('复制').click(); assert.equal(await layerCount(), 3);
  await button('下移').click();
  await page.getByRole('button', { name: '隐藏枝叶图案 副本', exact: true }).click();
  assert.equal(await page.locator('.placement-layer.hidden-layer').count(), 1);
  await page.getByRole('button', { name: '显示枝叶图案 副本', exact: true }).click();
  await button('删除').click(); assert.equal(await layerCount(), 2);
  completed.push('add, duplicate, reorder, visibility and delete');

  await setNumber('旋转角度', 24); await setNumber('不透明度', 63);
  await page.getByLabel('混合模式', { exact: true }).selectOption('multiply');
  await button('本地保存').click();
  await page.getByText(/本地已保存 ·/).waitFor();
  await setNumber('图案宽度', 400);
  await button('打开本地工程').click();
  await page.getByText('已打开当前浏览器保存的工程。', { exact: true }).waitFor();
  assert.equal(Number(await number('图案宽度').inputValue()), 225.3);
  assert.equal(Number(await number('旋转角度').inputValue()), 24);
  assert.equal(Number(await number('不透明度').inputValue()), 63);
  completed.push('IndexedDB save and reopen preserves layer transforms');

  const pngPath = await download('导出合成 PNG', '02-composite.png');
  const png = await fs.readFile(pngPath);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
  completed.push('PNG export is actual PNG at base dimensions');

  const jsonPath = await download('导出工程 JSON', '03-project.json');
  const project = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  assert.equal(project.layers.length, 2);
  await button('恢复示例构图').click();
  await page.getByRole('button', { name: '胸前花朵', exact: true }).waitFor();
  assert.equal(await layerCount(), 1);
  await page.locator('[data-input=project]').setInputFiles(jsonPath);
  await page.getByRole('button', { name: '枝叶图案', exact: true }).waitFor();
  assert.equal(await layerCount(), 2);
  completed.push('editable JSON export/import round trip and demo reset');

  await page.locator('[data-input=art]').setInputFiles(path.join(directory, '..', 'assets', 'garment.png'));
  await page.getByRole('button', { name: 'garment.png', exact: true }).waitFor();
  assert.equal(await layerCount(), 3);
  const uploadedJson = await download('导出工程 JSON', '04-embedded-upload.json');
  const embeddedProject = JSON.parse(await fs.readFile(uploadedJson, 'utf8'));
  assert.match(embeddedProject.layers.at(-1).src, /^data:image\/png;base64,/);
  await page.locator('[data-input=base]').setInputFiles(path.join(directory, '..', 'assets', 'garment.png'));
  await page.getByText('服装底图已替换；图案按新底图尺寸调整位置。原文件未修改。', { exact: true }).waitFor();
  completed.push('own artwork upload embedded in JSON and locked base replacement');

  const invalid = { ...project, layers: [{ ...project.layers[0], src: 'https://example.com/no.png' }] };
  await page.locator('[data-input=project]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.getByRole('alert').getByText('图案必须是内置素材或嵌入的 PNG / JPEG / WebP 图片。', { exact: true }).waitFor();
  assert.equal(await layerCount(), 3);
  completed.push('invalid imported source rejected without changing current project');

  await button('恢复示例构图').click();
  await page.getByRole('button', { name: '胸前花朵', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(qa, '05-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false);
  await canvas.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(Number(await number('横向 X').inputValue()), 666.6);
  completed.push('390px responsive layout without horizontal overflow; keyboard edit still works');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: completed.length, completed, errors }, null, 2));
  await fs.writeFile(path.join(qa, 'browser-results.json'), JSON.stringify({ passed: completed.length, completed, errors }, null, 2));
} finally { await browser.close(); }
