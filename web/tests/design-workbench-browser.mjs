import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { moduleDefinitions, toolDefinitions } from '../../shared/feature-catalog.ts';

const origin = process.env.DESIGN_WORKBENCH_TEST_URL || 'http://127.0.0.1:5347';
const owner = '00000000-0000-4000-8000-000000000099';
const image = await fs.readFile(new URL('../../labs/design-workbench/assets/garment.png', import.meta.url));
const output = resolve(import.meta.dirname, '../../output/design-workbench-browser');
await fs.mkdir(output, { recursive: true });
const assets = new Map();
const bytes = new Map();
const errors = [], unexpected = [], writes = [];
const assetId = '00000000-0000-4000-8000-000000000123';
assets.set(assetId, { id: assetId, ownerUserId: owner, ownerName: '隔离账号', filename: '素材库底图.png', kind: 'image', source: 'test', metadata: {}, status: 'ready', mimeType: 'image/png', byteSize: image.length, createdAt: new Date().toISOString(), contentUrl: `/api/assets/${assetId}/content`, thumbnailUrl: `/api/assets/${assetId}/content` });
bytes.set(assetId, image);
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, acceptDownloads: true });
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { unexpected.push(`external ${url.origin}`); return route.abort(); }
    if (path === '/__workbench-seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>isolated fixture</body></html>' });
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/deployment') return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (path === '/api/auth/session') return json({ user: { id: owner, username: 'workbench', displayName: '隔离账号', role: 'designer', status: 'active', departmentId: null, mustChangePassword: false, creditBalance: 0 } });
    if (path === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (path === '/api/models') return json({ models: [], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true })) });
    if (path === '/api/canvas-documents') return json({ documents: [] });
    if (path === '/api/assets') return json({ assets: [...assets.values()], nextCursor: null, hasMore: false });
    if (path === '/api/assets/upload-request') {
        const input = request.postDataJSON(); const id = crypto.randomUUID();
        writes.push(input); assets.set(id, { ...input, id, ownerUserId: owner, status: 'ready', createdAt: new Date().toISOString(), contentUrl: `/api/assets/${id}/content` });
        return json({ assetId: id, uploadUrl: `/api/test-upload/${id}` });
    }
    if (path.startsWith('/api/test-upload/')) { bytes.set(path.split('/').at(-1), request.postDataBuffer()); return json({}); }
    if (/^\/api\/assets\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: bytes.get(path.split('/')[3]) || image });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/tasks') return json({ tasks: [], nextCursor: null });
    if (path.startsWith('/api/generation-history')) return json({ history: [], total: 0 });
    if (path.startsWith('/api/usage')) return json({ code: 0, data: [], total: 0 });
    unexpected.push(`${request.method()} ${path}`); return json({ message: 'Unmocked request' }, 501);
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const status = page.locator('[data-project-status]');
async function saved() { await expect(status).toHaveText('已自动保存到本机'); }
try {
    await page.goto(origin + '/__workbench-seed');
    await page.evaluate(async owner => {
        const project = { type: 'garment-pattern-placement', version: 1, base: { src: '/design-workbench/assets/garment.png', width: 1024, height: 1024, name: '原有底图' }, layers: [{ id: 'original', name: '原有图层', src: '/design-workbench/assets/flower.svg', x: 500, y: 420, width: 200, aspect: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }] };
        // Match the actual flower aspect instead of assuming a square fixture.
        const img = new Image(); img.src = '/design-workbench/assets/flower.svg'; await img.decode(); project.layers[0].aspect = img.naturalWidth / img.naturalHeight;
        await new Promise((resolve, reject) => {
            const request = indexedDB.open(`wireless-canvas:oa:user:${encodeURIComponent(owner)}`, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('design_workbench_projects');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db = request.result; const tx = db.transaction('design_workbench_projects', 'readwrite'); tx.objectStore('design_workbench_projects').put(project, `owner:${owner}:garment-pattern-placement-v1`); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        });
    }, owner);
    await page.goto(origin + '/creative/pattern-placement');
    await expect(page.getByRole('combobox', { name: '本地工程' })).toHaveValue('legacy');
    await expect(page.getByRole('spinbutton', { name: '图案宽度', exact: true })).toHaveValue('200');
    page.once('dialog', dialog => dialog.accept('第二个工程'));
    await page.getByRole('button', { name: '新建工程', exact: true }).click(); await saved();
    const second = await page.getByRole('combobox', { name: '本地工程' }).inputValue();
    const width = page.getByRole('spinbutton', { name: '图案宽度', exact: true });
    await width.fill('333'); await expect(status).toContainText('有未保存更改'); await width.press('Tab'); await saved();
    await page.getByRole('combobox', { name: '本地工程' }).selectOption('legacy');
    await expect(width).toHaveValue('200');
    await page.getByRole('combobox', { name: '本地工程' }).selectOption(second); await expect(width).toHaveValue('333');
    await page.reload(); await expect(width).toHaveValue('333'); await saved();
    // Inject a failing storage boundary, not a fake editor state.
    await page.evaluate(() => { window.workbenchOriginalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { if (this.name === 'design_workbench_projects') throw new DOMException('存储已满', 'QuotaExceededError'); return window.workbenchOriginalPut.apply(this, args); }; });
    await width.fill('334'); await width.press('Tab'); await expect(status).toContainText('保存失败');
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), true);
    await page.getByRole('link', { name: '← 创意工作台', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.workbenchOriginalPut; });
    await page.getByRole('button', { name: '本地保存', exact: true }).click(); await saved();
    await page.getByRole('button', { name: '从素材库选择底图', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /素材库底图/ }).click();
    await expect(page.locator('.placement-base-name')).toHaveText('素材库底图.png'); await saved();
    await page.getByRole('button', { name: '保存合成图到素材库', exact: true }).click();
    await expect(page.getByText('已保存到素材库，可继续用于画布或生成参考图。', { exact: true })).toBeVisible();
    assert.equal(writes.length, 1); const composite = bytes.get([...assets.keys()].at(-1));
    assert.equal(composite.subarray(1, 4).toString(), 'PNG'); assert.equal(composite.readUInt32BE(16), 1024);
    await page.screenshot({ path: resolve(output, 'placement.png'), fullPage: true });
    await page.goto(origin + '/creative/pattern-repeat');
    await page.getByRole('button', { name: '从素材库添加元素', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /素材库底图/ }).click();
    await expect(page.locator('[data-role=item-count]')).toContainText('8 / 32'); await saved();
    await page.getByRole('button', { name: '保存无缝周期到素材库', exact: true }).click();
    await expect(page.locator('[data-role=status]')).toHaveText('无缝周期已保存到素材库。');
    assert.equal(writes.length, 2); const period = bytes.get([...assets.keys()].at(-1));
    assert.equal(period.subarray(1, 4).toString(), 'PNG'); assert.equal(period.readUInt32BE(16), 1182); assert.equal(period.readUInt32BE(20), 591);
    await page.reload(); await expect(page.locator('[data-role=item-count]')).toContainText('8 / 32'); await saved();
    await page.screenshot({ path: resolve(output, 'repeat.png'), fullPage: true });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, originalProjectPreserved: true, autosaveReload: true, failedSaveNavigationGuard: true, assetPickerImports: 2, assetUploads: writes.length, imageSizes: ['1024x1024', '1182x591'], errors, unexpected }));
} catch (error) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
    throw error;
} finally { await context.close(); await browser.close(); }
