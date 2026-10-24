import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { moduleDefinitions, toolDefinitions } from '../../shared/feature-catalog.ts';

const origin = process.env.CREATIVE_SCENE_TEST_URL || 'http://127.0.0.1:5347';
const owner = '00000000-0000-4000-8000-000000000099';
const model = { id: '00000000-0000-4000-8000-000000000021', modelId: 'gpt-image-2', name: '隔离图像模型', capabilities: ['generate', 'edit'], creditCost: 0, rmbCost: 0 };
const config = { model: model.id, imageModel: model.id, size: '1024x1024', quality: 'auto', count: '1', systemPrompt: '冻结系统要求' };
const image = await fs.readFile(new URL('../../labs/design-workbench/assets/garment.png', import.meta.url));
const imageData = `data:image/png;base64,${image.toString('base64')}`;
const output = resolve(import.meta.dirname, '../../output/creative-scene-browser'); await fs.mkdir(output, { recursive: true });
const assets = new Map(), uploadBytes = new Map(), clientReferences = new Map(), tasks = new Map(), documents = new Map();
const errors = [], unexpected = [], submissions = [], assetRequests = [];
let nextStatus = 'success';
const archive = { version: 1, ownerId: owner, modelConfigId: model.id, modelId: model.modelId, prompt: '冻结原描述', effectivePrompt: '冻结系统要求\n\n冻结原描述', config,
    parameters: { size: '1024x1024', quality: 'auto', keepExact: 'original-value' }, references: [] };
tasks.set('seed-failed', { id: 'seed-failed', status: 'failed', requestId: 'seed:0', userId: owner, modelConfigId: model.id, prompt: archive.effectivePrompt, operationType: 'image_generation', sourceUrls: [], resultUrls: [], failureReason: '明确失败', parameters: { tool: 'creative-text-to-style', inputArchive: archive } });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 } });
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { unexpected.push(`external ${url.origin}`); return route.abort(); }
    if (path === '/__creative-seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>isolated</body></html>' });
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/deployment') return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (path === '/api/auth/session') return json({ user: { id: owner, username: 'creative', displayName: '隔离账号', role: 'designer', status: 'active', departmentId: null, mustChangePassword: false, creditBalance: 0 } });
    if (path === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (path === '/api/models') return json({ models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, modelConfigId: model.id, enabled: true, creditCostOverride: null, rmbCostOverride: null })) });
    if (path === '/api/canvas-documents') return json({ documents: [...documents.values()] });
    if (path.startsWith('/api/canvas-documents/')) {
        const id = path.split('/').at(-1);
        if (request.method() === 'PUT') { const input = request.postDataJSON(); documents.set(id, { id, revision: input.baseRevision + 1, deleted: false, document: input.document, updatedAt: new Date().toISOString() }); }
        return json({ document: documents.get(id) || { id, revision: 0, deleted: true, document: null, updatedAt: new Date().toISOString() } });
    }
    if (path === '/api/tasks/events') return route.fulfill({ contentType: 'text/event-stream', body: ': isolated\n\n' });
    if (path === '/api/tasks' && request.method() === 'POST') {
        const input = request.postDataJSON(); submissions.push(input); const id = `task-${submissions.length}`;
        const task = { ...input, id, userId: owner, status: nextStatus, resultUrls: nextStatus === 'success' ? ['/api/assets/result/content'] : [], failureReason: nextStatus === 'failed' ? '夹具明确失败' : '等待原任务核查', upstreamTaskId: nextStatus === 'paused' ? 'paid-original' : null };
        tasks.set(id, task); return json({ task });
    }
    if (/^\/api\/tasks\/[^/]+$/.test(path)) return json({ task: tasks.get(path.split('/').at(-1)) || null });
    if (path === '/api/tasks') return json({ tasks: [], nextCursor: null });
    if (path === '/api/assets/upload-request') {
        const input = request.postDataJSON(); assetRequests.push(input);
        const old = clientReferences.get(input.clientReferenceId); if (old) return json({ assetId: old, uploadUrl: null });
        const id = crypto.randomUUID(); clientReferences.set(input.clientReferenceId, id); assets.set(id, { ...input, id, ownerUserId: owner, status: 'ready', metadata: input.metadata || {}, contentUrl: `/api/assets/${id}/content` });
        return json({ assetId: id, uploadUrl: `/api/test-upload/${id}` });
    }
    if (path.startsWith('/api/test-upload/')) { uploadBytes.set(path.split('/').at(-1), request.postDataBuffer()); return json({}); }
    if (/^\/api\/assets\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: uploadBytes.get(path.split('/')[3]) || image });
    if (/^\/api\/assets\/[^/]+\/events$/.test(path)) return json({ eventId: 'fixture', projection: {} });
    if (/^\/api\/assets\/[^/]+$/.test(path)) return json({ asset: assets.get(path.split('/').at(-1)) });
    if (path === '/api/assets') return json({ assets: [...assets.values()], nextCursor: null, hasMore: false });
    if (path === '/api/projects') return json({ projects: [] });
    if (path.startsWith('/api/generation-history')) return json({ history: [], total: 0 });
    if (path.startsWith('/api/usage')) return json({ code: 0, data: [], total: 0 });
    unexpected.push(`${request.method()} ${path}`); return json({ message: 'Unmocked request' }, 501);
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const historyButton = () => page.getByRole('button', { name: /^最近任务/ });
const retryButton = () => page.getByRole('button', { name: '按原输入仅重试此张', exact: true });
async function openHistory(index) { await historyButton().click(); await page.locator('.cs-history-item').nth(index).click(); await expect(page.getByText('正在读取所选结果…', { exact: true })).toHaveCount(0); }
try {
    await page.goto(origin + '/__creative-seed');
    await page.evaluate(async ({ owner, config, imageData }) => {
        const { createSceneForm } = await import('/src/pages/creative/scene-form-model.ts');
        const form = { ...createSceneForm('text-to-style'), description: '当前草稿要求，不能影响历史重试' };
        const pic = { id: 'old-image', name: '历史成功原图', type: 'image/png', mimeType: 'image/png', dataUrl: imageData, width: 1024, height: 1024, bytes: 1 };
        const old = Array.from({ length: 45 }, (_, index) => ({ id: `old-${index}`, ownerId: owner, sceneId: 'text-to-style', createdAt: 1700000000000 - index * 1000, prompt: '冻结原描述', form,
            config, referenceImages: {}, results: index === 0 ? [{ id: 'failed-one', taskId: 'seed-failed', status: 'failed', failureKind: 'terminal', error: '明确失败' }] : index === 1 ? [{ id: 'paused-one', taskId: 'seed-paused', status: 'failed', failureKind: 'uncertain', error: '查询暂停' }] : [{ id: `success-${index}`, status: 'success', image: pic }],
            images: index > 1 ? [pic] : [], inputArchiveVersion: 1, operation: 'ai', durationMs: 1, successCount: index > 1 ? 1 : 0, failCount: index > 1 ? 0 : 1 }));
        await new Promise((resolve, reject) => {
            const request = indexedDB.open(`wireless-canvas:oa:user:${encodeURIComponent(owner)}`, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('creative_scene_workspaces'); request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db = request.result, tx = db.transaction('creative_scene_workspaces', 'readwrite'), store = tx.objectStore('creative_scene_workspaces');
                store.put(old, `history:${owner}:text-to-style`); store.put({ form, images: {}, config }, `draft:${owner}:text-to-style`);
                tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        });
    }, { owner, config, imageData });
    await page.addInitScript(() => { window.creativeReads = []; const original = IDBObjectStore.prototype.get; IDBObjectStore.prototype.get = function(key) { if (this.name === 'creative_scene_workspaces') window.creativeReads.push(String(key)); return original.call(this, key); }; });
    await page.goto(origin + '/creative/text-to-style'); await historyButton().click();
    await expect(page.locator('.cs-history-item')).toHaveCount(20);
    assert.equal(await page.evaluate(() => window.creativeReads.some(key => key.startsWith('history-record:'))), false);
    await page.getByRole('button', { name: '加载更多（已显示 20 / 45）', exact: true }).click(); await expect(page.locator('.cs-history-item')).toHaveCount(40);
    await page.locator('.cs-history-item').first().click(); await expect(retryButton()).toBeEnabled();
    await retryButton().evaluate(button => { button.click(); button.click(); });
    await expect(page.getByRole('button', { name: '保存到素材库', exact: true })).toBeEnabled();
    assert.equal(submissions.length, 1); assert.equal(submissions[0].prompt, archive.effectivePrompt); assert.equal(submissions[0].modelConfigId, model.id);
    assert.equal(submissions[0].parameters.keepExact, 'original-value'); assert.equal(submissions[0].parameters.count, 1);
    await openHistory(1); await expect(retryButton()).toHaveCount(0); await expect(page.getByText('此失败项已发起过重试，请查看对应的新记录。')).toBeVisible();
    await openHistory(2); await expect(retryButton()).toHaveCount(0); await expect(page.getByText('请在任务中心查询或恢复原任务，不要重新生成。')).toBeVisible();
    await openHistory(0); await page.getByRole('button', { name: '保存到素材库', exact: true }).click(); await expect(page.getByText('原图已保存到素材库。', { exact: true })).toBeVisible();
    assert.equal(assets.size, 1); assert.equal([...uploadBytes.values()][0].equals(image), true);
    await page.getByRole('button', { name: '作为参考继续改', exact: true }).click(); await expect(page).toHaveURL(/\/image\?.*tool=image-edit/);
    await expect(page.getByText('已带入原素材、提示词和模型', { exact: true })).toBeVisible(); assert.equal(assets.size, 1); assert.equal(submissions.length, 1);
    await page.goto(origin + '/creative/text-to-style'); await openHistory(0);
    await page.getByRole('button', { name: '加入新画布', exact: true }).click(); await expect(page).toHaveURL(/\/canvas\/[^/]+$/);
    await expect.poll(() => documents.size).toBe(1); assert.equal(assets.size, 1); assert.equal(submissions.length, 1);
    await page.goto(origin + '/creative/text-to-style'); nextStatus = 'failed';
    await expect(page.getByRole('button', { name: /生成款式/ })).toBeEnabled();
    await page.evaluate(async owner => { const { workbenchSubmissions } = await import('/src/lib/submission-gate.ts'); window.releaseCreativeImageGate = workbenchSubmissions.acquire(`image:${owner}`); }, owner);
    await page.getByRole('button', { name: /生成款式/ }).evaluate(button => { button.click(); button.click(); });
    await expect(retryButton()).toBeEnabled(); assert.equal(submissions.length, 2);
    nextStatus = 'paused'; await retryButton().click();
    await expect(page.getByText('请在任务中心查询或恢复原任务，不要重新生成。')).toBeVisible(); await expect(retryButton()).toHaveCount(0); assert.equal(submissions.length, 3);
    await page.evaluate(() => window.releaseCreativeImageGate());
    await page.screenshot({ path: resolve(output, 'uncertain-retry.png'), fullPage: true });
    const preserved = await page.evaluate(async owner => { const { createWorkspaceStorage } = await import('/src/lib/workspace-storage.ts'); const store = createWorkspaceStorage('creative_scene_workspaces'); return (await store.getItem(`history:${owner}:text-to-style`)).length; }, owner);
    assert.equal(preserved, 45);
    await openHistory(2); await expect(page.locator('.cs-result-actions button')).toHaveCount(3);
    await page.screenshot({ path: resolve(output, 'result-actions-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.cs-result-actions').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, 'result-actions-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ passed: true, legacyRecordsPreserved: preserved, pageSize: 20, nextPage: 40, fixtureTaskPosts: submissions.length, actualModelCalls: 0, frozenSingleRetry: true, consumedFailureNoReplay: true, pausedNoRetry: true, imageGateIndependent: true, resultAssetCopies: assets.size, canvasDocuments: documents.size, continueEditImported: true, errors, unexpected }));
} catch (error) { console.error(await page.locator('body').innerText()); console.error(JSON.stringify({ errors, unexpected, submissions: submissions.length })); await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); throw error; }
finally { await context.close(); await browser.close(); }
