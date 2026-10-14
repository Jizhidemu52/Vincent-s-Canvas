import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const qa = path.join(dir, 'qa');
const assetDir = path.resolve(dir, '../../design-workbench/assets');
await fs.mkdir(qa, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], blocked = [], results = [], states = {};
const externalResponses = [];
page.on('response', response => { const url = response.url(); if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1:4330/')) externalResponses.push({ url, status: response.status() }); });
page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message }));
page.on('console', message => { if (message.type() === 'error') errors.push({ type: 'console', message: message.text() }); });
await page.route('**/*', async route => {
  const url = route.request().url();
  if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1:4330/')) { blocked.push(url); return route.abort('blockedbyclient'); }
  return route.continue();
});
const record = (name, passed, evidence) => { results.push({ name, passed, evidence }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(evidence)}`); };
const readState = () => page.evaluate(() => {
  const editor = document.querySelector('.home').__vueParentComponent.provides.canvasEditor;
  return { plugins: Object.keys(editor.pluginMap), history: { clearHistoryType: typeof editor.canvas.clearHistory, nativeUndoType: typeof editor.canvas.undo, editorUndoType: typeof editor.undo, pluginStackIsArray: Array.isArray(editor.getPlugin('HistoryPlugin').stack) }, viewport: [...editor.canvas.viewportTransform], activeId: editor.canvas.getActiveObject()?.id,
    objects: editor.canvas.getObjects().map(obj => ({ id: obj.id, type: obj.type, left: obj.left, top: obj.top, width: obj.width, height: obj.height, scaleX: obj.scaleX, scaleY: obj.scaleY, angle: obj.angle, opacity: obj.opacity, selectable: obj.selectable, hasControls: obj.hasControls, lockMovementX: obj.lockMovementX, lockMovementY: obj.lockMovementY, lockRotation: obj.lockRotation, lockScalingX: obj.lockScalingX, lockScalingY: obj.lockScalingY, childCount: obj._objects?.length })) };
});
async function insert(menuName, file) {
  await page.getByText('插入', { exact: true }).hover();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText(menuName, { exact: true }).click();
  await (await chooser).setFiles(file);
}
async function editPosition(axis, value) {
  const box = page.locator('.right-bar .box.attr-item-box').filter({ has: page.getByText('位置信息', { exact: true }) });
  const input = box.locator('.ivu-input-number-input-wrap').filter({ has: page.getByText(axis, { exact: true }) }).locator('input');
  await input.fill(String(value)); await input.press('Tab');
}
async function resizeActive(factor) {
  const info = await page.evaluate(() => {
    const editor = document.querySelector('.home').__vueParentComponent.provides.canvasEditor;
    const obj = editor.canvas.getActiveObject();
    const box = editor.canvas.upperCanvasEl.getBoundingClientRect();
    return { left: box.left, top: box.top, br: { x: obj.oCoords.br.x, y: obj.oCoords.br.y }, tl: { x: obj.oCoords.tl.x, y: obj.oCoords.tl.y } };
  });
  const start = { x: info.left + info.br.x, y: info.top + info.br.y };
  const end = { x: info.left + info.tl.x + (info.br.x - info.tl.x) * factor, y: info.top + info.tl.y + (info.br.y - info.tl.y) * factor };
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 15 }); await page.mouse.up();
}
async function dragAtObject(id, dx, dy) {
  const center = await page.evaluate(id => {
    const editor = document.querySelector('.home').__vueParentComponent.provides.canvasEditor;
    const obj = editor.canvas.getObjects().find(item => item.id === id);
    const p = obj.getCenterPoint(); const v = editor.canvas.viewportTransform;
    const bounds = editor.canvas.upperCanvasEl.getBoundingClientRect();
    return { x: bounds.x + p.x * v[0] + v[4], y: bounds.y + p.y * v[3] + v[5] };
  }, id);
  await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(center.x + dx, center.y + dy, { steps: 10 }); await page.mouse.up();
}
async function exportFile(label, filename) {
  await page.getByText('下载', { exact: true }).hover();
  const pending = page.waitForEvent('download');
  await page.getByText(label, { exact: true }).click();
  const file = await pending; await file.saveAs(path.join(qa, filename)); return path.join(qa, filename);
}

try {
  const navigation = await page.goto('http://127.0.0.1:4330/', { waitUntil: 'networkidle' });
  const csp = navigation.headers()['content-security-policy'];
  record('本地主机响应包含阻断第三方的 CSP', csp?.includes("connect-src 'self'") && csp?.includes("img-src 'self' data: blob:"), csp);
  await page.locator('.upper-canvas').waitFor();
  states.initial = await readState();
  assert.ok(states.initial.plugins.includes('LayerPlugin')); assert.ok(states.initial.plugins.includes('LockPlugin')); assert.ok(states.initial.plugins.includes('ServersPlugin'));
  record('原 App.vue/home.vue 注册原 core 插件', true, { plugins: states.initial.plugins });

  await page.locator('.right-bar button').filter({ has: page.locator('.ivu-icon-md-create') }).click();
  const sizeModal = page.locator('.ivu-modal:visible').filter({ hasText: '调整画布尺寸' });
  const sizeInputs = sizeModal.locator('input:not([type=hidden])');
  await sizeInputs.nth(0).fill('1024'); await sizeInputs.nth(0).press('Tab');
  await sizeInputs.nth(1).fill('1024'); await sizeInputs.nth(1).press('Tab');
  await sizeModal.getByRole('button', { name: '确定', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.home').__vueParentComponent.provides.canvasEditor.getWorkspase().width === 1024);
  record('原尺寸弹窗修改为 1024 × 1024', true, (await readState()).objects[0]);

  await insert('插入图片', path.join(assetDir, 'garment.png'));
  await page.waitForFunction(() => document.querySelector('.home').__vueParentComponent.provides.canvasEditor.canvas.getObjects().length === 2);
  let current = await readState(); const baseId = current.objects.at(-1).id;
  assert.equal(current.objects.at(-1).type, 'image');
  await resizeActive(2);
  await editPosition('X轴', 0); await editPosition('Y轴', 0);
  current = await readState();
  record('原插入图片和 ControlsPlugin 缩放底图', current.objects.at(-1).scaleX > .95, current.objects.at(-1));
  await page.locator('.right-bar .bg-item button').filter({ has: page.locator('.ivu-icon-md-unlock') }).click();
  states.locked = await readState();
  const baseBefore = states.locked.objects.find(obj => obj.id === baseId);
  assert.equal(baseBefore.lockMovementX, true); assert.equal(baseBefore.lockScalingX, true);
  await dragAtObject(baseId, 50, 40);
  const baseAfter = (await readState()).objects.find(obj => obj.id === baseId);
  record('原 LockPlugin 阻止底图拖动', baseBefore.left === baseAfter.left && baseBefore.top === baseAfter.top, { before: baseBefore, after: baseAfter });

  await insert('插入SVG元素', path.join(assetDir, 'flower.svg'));
  await page.waitForFunction(() => document.querySelector('.home').__vueParentComponent.provides.canvasEditor.canvas.getObjects().length === 3);
  current = await readState(); const flowerId = current.objects.at(-1).id;
  assert.equal(current.objects.at(-1).type, 'group'); assert.ok(current.objects.at(-1).childCount > 1);
  await resizeActive(.32);
  await editPosition('X轴', 570); await editPosition('Y轴', 360);
  states.positioned = await readState();
  const positioned = states.positioned.objects.find(obj => obj.id === flowerId);
  record('原属性面板设置 X/Y', positioned.left === 570 && positioned.top === 360, positioned);
  let positionPanel = page.locator('.right-bar .box.attr-item-box').filter({ has: page.getByText('位置信息', { exact: true }) });
  const rotationTrack = positionPanel.locator('.ivu-form-item').filter({ hasText: '旋转' }).locator('.ivu-slider-wrap');
  const opacityTrack = positionPanel.locator('.ivu-form-item').filter({ hasText: '透明' }).locator('.ivu-slider-wrap');
  await rotationTrack.click({ position: { x: 10, y: 2 } });
  const opacityBounds = await opacityTrack.boundingBox();
  await opacityTrack.click({ position: { x: opacityBounds.width * .8, y: 2 } });
  states.transformed = await readState();
  const flower = states.transformed.objects.find(obj => obj.id === flowerId);
  record('原 SVG 导入分组及缩放/旋转/透明度控件', flower.scaleX < 1 && flower.angle > 0 && flower.opacity < 1, flower);
  await dragAtObject(flowerId, 25, 15);
  const flowerMoved = (await readState()).objects.find(obj => obj.id === flowerId);
  record('原画布鼠标拖动图案', flowerMoved.left !== flower.left && flowerMoved.top !== flower.top, { before: flower, after: flowerMoved });

  await page.getByText('图层', { exact: true }).first().click();
  await page.locator('.layer-box').waitFor();
  await page.locator('.layer-box > div').first().click();
  const layerButtons = page.locator('.left-panel .btn-box button');
  await layerButtons.nth(1).click();
  const orderDown = (await readState()).objects.map(obj => obj.id);
  await layerButtons.nth(0).click();
  const orderUp = (await readState()).objects.map(obj => obj.id);
  record('原 LayerPlugin 上下排序及 workspace 保底', orderDown[0] === 'workspace' && orderDown[1] === flowerId && orderUp.at(-1) === flowerId, { orderDown, orderUp });
  states.beforeExport = await readState();
  await page.screenshot({ path: path.join(qa, '02-original-composition.png'), fullPage: true });

  const jsonPath = await exportFile('保存为JSON', 'native-project.json');
  const project = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const exportedBase = project.objects.find(obj => obj.id === baseId);
  record('原 ServersPlugin JSON 下载含嵌入图片及 SVG 矢量组', exportedBase.src?.startsWith('data:image/png;base64,') && project.objects.find(obj => obj.id === flowerId)?.objects?.length > 1, { objects: project.objects.length, baseEmbedded: exportedBase.src?.startsWith('data:image/png;base64,'), baseLockFields: { lockMovementX: exportedBase.lockMovementX, lockMovementY: exportedBase.lockMovementY, lockScalingX: exportedBase.lockScalingX }, groupChildren: project.objects.find(obj => obj.id === flowerId)?.objects?.length });
  const pngPath = await exportFile('PNG图片', 'native-composite.png');
  const png = await fs.readFile(pngPath);
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), signature: png.subarray(1, 4).toString(), bytes: png.length };
  record('原 ServersPlugin PNG 下载格式和原尺寸', dimensions.signature === 'PNG' && dimensions.width === 1024 && dimensions.height === 1024, dimensions);

  await page.getByRole('button', { name: '清空', exact: true }).click();
  await page.locator('.ivu-modal-confirm').getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.home').__vueParentComponent.provides.canvasEditor.canvas.getObjects().length === 1);
  record('原清空路径无运行时异常', !errors.some(item => item.message.includes('clearHistory is not a function')), { clearHistoryError: errors.filter(item => item.message.includes('clearHistory is not a function')), runtime: (await readState()).history });
  await page.getByText('文件', { exact: true }).first().hover();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('导入文件', { exact: true }).click();
  await (await chooser).setFiles(jsonPath);
  await page.waitForFunction(() => document.querySelector('.home').__vueParentComponent.provides.canvasEditor.canvas.getObjects().length === 3);
  states.reopened = await readState();
  const beforeFlower = states.beforeExport.objects.find(obj => obj.id === flowerId);
  const reopenedFlower = states.reopened.objects.find(obj => obj.id === flowerId);
  const fields = ['id', 'type', 'left', 'top', 'scaleX', 'scaleY', 'angle', 'opacity', 'childCount'];
  const differences = fields.filter(key => typeof beforeFlower[key] === 'number' ? Math.abs(beforeFlower[key] - reopenedFlower[key]) > .0001 : beforeFlower[key] !== reopenedFlower[key]);
  record('原 JSON 文件导入恢复图案变换、组结构和层序', differences.length === 0 && states.beforeExport.objects.map(obj => obj.id).join(',') === states.reopened.objects.map(obj => obj.id).join(','), { differences, before: beforeFlower, after: reopenedFlower });
  const reopenedBase = states.reopened.objects.find(obj => obj.id === baseId);
  record('锁定状态在原 JSON 往返后保持', reopenedBase.lockMovementX === true && reopenedBase.lockScalingX === true, { before: baseBefore, after: reopenedBase, exportedHasLockMovementX: Object.hasOwn(exportedBase, 'lockMovementX') });
  await page.screenshot({ path: path.join(qa, '03-original-json-reopened.png'), fullPage: true });
  const reopenedPngPath = await exportFile('PNG图片', 'native-composite-reopened.png');
  const reopenedPng = await fs.readFile(reopenedPngPath);
  const rgbaDifference = await page.evaluate(async sources => {
    const pixels = await Promise.all(sources.map(src => new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); resolve(ctx.getImageData(0, 0, canvas.width, canvas.height).data); }; image.onerror = reject; image.src = src;
    })));
    const [a, b] = pixels; let differentPixels = 0, maxChannelDifference = 0, totalChannelDifference = 0, changedGt10 = 0;
    for (let index = 0; index < a.length; index += 4) { let changed = false, over10 = false; for (let channel = 0; channel < 4; channel++) { const diff = Math.abs(a[index + channel] - b[index + channel]); if (diff) changed = true; if (diff > 10) over10 = true; maxChannelDifference = Math.max(diff, maxChannelDifference); totalChannelDifference += diff; } if (changed) differentPixels++; if (over10) changedGt10++; }
    return { totalPixels: a.length / 4, differentPixels, changedPercent: differentPixels / (a.length / 4) * 100, maxChannelDifference, meanAbsoluteChannelDifference: totalChannelDifference / a.length, pixelsWithChannelDifferenceGt10: changedGt10 };
  }, [png, reopenedPng].map(buffer => `data:image/png;base64,${buffer.toString('base64')}`));
  await fs.writeFile(path.join(qa, 'rgba-difference.json'), JSON.stringify(rgbaDifference, null, 2));
  record('JSON 往返渲染误差量化（非字节一致断言）', rgbaDifference.meanAbsoluteChannelDifference < .05, { byteIdentical: png.equals(reopenedPng), beforeBytes: png.length, afterBytes: reopenedPng.length, rgbaDifference, interpretation: '四位小数序列化后的误差；此阈值仅是本测试的小误差提示，不代替业务视觉验收。' });
  record('本地素材流程完全阻断外网', externalResponses.length === 0 && Boolean(csp), { externalResponses, routeBlockedCount: blocked.length, cspViolationMessages: errors.filter(item => /Content Security Policy|violates the following Content Security Policy/.test(item.message)).length });
} catch (error) {
  results.push({ name: '测试脚本中断', passed: false, evidence: { message: error.message, stack: error.stack } });
  console.error(error);
  await page.screenshot({ path: path.join(qa, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(qa, 'results.json'), JSON.stringify({ upstream: 'https://github.com/ikuaitu/vue-fabric-editor', commit: 'b3bdcfb0bd6d8f98e7483cf561ac03ba56c0d889', testedAt: new Date().toISOString(), positive: results.filter(item => item.passed).length, negative: results.filter(item => !item.passed).length, results, states, blocked, externalResponses, errors }, null, 2));
  await browser.close();
}
