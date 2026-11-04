import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { moduleDefinitions, toolDefinitions } from '../../shared/feature-catalog.ts';

// An isolated browser and fully mocked API: never contacts an upstream or incurs a model charge.
const origin = process.env.PLACEMENT_AI_TEST_URL || 'http://127.0.0.1:5358';
const owner = '00000000-0000-4000-8000-000000000099';
const model = { id: '00000000-0000-4000-8000-000000000021', modelId: 'gpt-image-2', name: '隔离图像模型', capabilities: ['generate', 'edit'], creditCost: 0, rmbCost: 0 };
const original = await fs.readFile(new URL('../../labs/design-workbench/assets/garment.png', import.meta.url));
const output = resolve(import.meta.dirname, '../../output/placement-ai-browser');
await fs.mkdir(output, { recursive: true });
const assets = new Map(), bytes = new Map(), tasks = new Map();
const errors = [], unexpected = [], submissions = [];
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 } });
await context.routeWebSocket('**/*', socket => socket.close());
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { unexpected.push(`external ${url.origin}`); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/deployment') return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (path === '/api/auth/session') return json({ user: { id: owner, username: 'placement', displayName: '隔离账号', role: 'designer', status: 'active', departmentId: null, mustChangePassword: false, creditBalance: 0 } });
    if (path === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (path === '/api/models') return json({ models: [model], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, modelConfigId: model.id, enabled: true, creditCostOverride: null, rmbCostOverride: null })) });
    if (path === '/api/release-notes') return json({ notes: [], nextCursor: null, hasMore: false });
    if (path === '/api/canvas-documents') return json({ documents: [] });
    if (path === '/api/tasks/events') return route.fulfill({ contentType: 'text/event-stream', body: ': isolated\n\n' });
    if (path === '/api/tasks' && request.method() === 'POST') {
        const input = request.postDataJSON(); submissions.push(input);
        const task = { ...input, id: `placement-task-${submissions.length}`, userId: owner, status: 'success', resultUrls: ['/api/assets/fixture-result/content'], failureReason: null };
        tasks.set(task.id, task); return json({ task });
    }
    if (/^\/api\/tasks\/[^/]+$/.test(path)) return json({ task: tasks.get(path.split('/').at(-1)) || null });
    if (/^\/api\/tasks\/[^/]+\/progress$/.test(path)) return json({ progress: { taskId: path.split('/')[3], status: 'success', phase: 'complete', runtime: 'demo', queuePosition: null, estimatedWaitSeconds: null, estimatedRemainingSeconds: null, sampleCount: 0, estimateReason: null, retryAfterSeconds: null } });
    if (path === '/api/tasks') return json({ tasks: [], nextCursor: null });
    if (path === '/api/assets/upload-request') {
        const input = request.postDataJSON(), id = crypto.randomUUID();
        assets.set(id, { ...input, id, ownerUserId: owner, status: 'ready', metadata: input.metadata || {}, contentUrl: `/api/assets/${id}/content` });
        return json({ assetId: id, uploadUrl: `/api/test-upload/${id}` });
    }
    if (path.startsWith('/api/test-upload/')) { bytes.set(path.split('/').at(-1), request.postDataBuffer()); return json({}); }
    if (/^\/api\/assets\/[^/]+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: bytes.get(path.split('/')[3]) || original });
    if (/^\/api\/assets\/[^/]+$/.test(path)) return json({ asset: assets.get(path.split('/').at(-1)) });
    if (path === '/api/assets') return json({ assets: [], nextCursor: null, hasMore: false });
    if (path === '/api/projects') return json({ projects: [] });
    if (path.startsWith('/api/generation-history')) return json({ history: [], total: 0 });
    if (path.startsWith('/api/usage')) return json({ code: 0, data: [], total: 0 });
    unexpected.push(`${request.method()} ${path}`); return json({ message: 'Unmocked request' }, 501);
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
try {
    await page.goto(origin + '/image?tool=image-edit');
    const prompt = page.getByRole('textbox', { name: '图像提示词' });
    await expect(prompt).toBeVisible();
    await prompt.fill('原图片编辑草稿，必须保留');
    await expect.poll(() => page.evaluate(async owner => {
        const lf = (await import('/node_modules/.vite/deps/localforage.js')).default;
        return lf.createInstance({ name: `wireless-canvas:oa:user:${encodeURIComponent(owner)}`, storeName: 'generation_drafts' }).getItem('image-edit:prompt');
    }, owner)).toBe('原图片编辑草稿，必须保留');
    await page.goto(origin + '/creative/pattern-placement');
    await expect(page.getByRole('button', { name: '生成 AI 效果图', exact: true })).toBeEnabled();
    await page.getByRole('spinbutton', { name: '图案宽度', exact: true }).fill('260');
    await page.getByRole('spinbutton', { name: '图案宽度', exact: true }).press('Tab');
    await page.screenshot({ path: resolve(output, 'placement-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '生成 AI 效果图', exact: true }).click();
    await expect(page).toHaveURL(/\/image\?tool=image-edit&placementToken=/);
    await expect(page.getByText('服装定位 · AI 效果图', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '参考图', exact: true }).locator('img')).toHaveCount(3);
    await expect(prompt).toHaveValue(/宽 25.39%/);
    await expect(page.getByRole('button', { name: '开始编辑', exact: true })).toBeEnabled();
    assert.equal(submissions.length, 0, 'Handoff must not auto-submit');
    const tokenUrl = page.url();
    const promptValue = await prompt.inputValue();
    const caseToggle = page.getByTestId('practice-example-toggle').first();
    await expect(caseToggle).toBeVisible();
    assert.ok((await caseToggle.boundingBox()).height < 220, 'Collapsed case must not squeeze its title into one-character columns');
    await page.screenshot({ path: resolve(output, 'ai-ready-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: resolve(output, 'ai-ready-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mobile page overflows horizontally');
    await page.setViewportSize({ width: 1512, height: 1100 });
    await prompt.fill(promptValue + '\n只调整面料融合，保留后续编辑。');
    await page.reload();
    await expect(prompt).toHaveValue(/保留后续编辑/);
    await expect(page.getByRole('region', { name: '参考图', exact: true }).locator('img')).toHaveCount(3);
    assert.equal(submissions.length, 0, 'Reload must not submit');
    await page.getByRole('link', { name: '打开原图片编辑草稿', exact: true }).click();
    await expect(prompt).toHaveValue('原图片编辑草稿，必须保留');
    await page.goto(tokenUrl);
    await expect(prompt).toHaveValue(/保留后续编辑/);
    await page.getByRole('button', { name: '开始编辑', exact: true }).click();
    await expect.poll(() => submissions.length).toBe(1);
    await expect(page.getByText('已生成并保存 1 张图片', { exact: true })).toBeVisible();
    const submitted = submissions[0];
    assert.equal(submitted.operationType, 'inpaint');
    assert.equal(submitted.toolKey, 'image-edit');
    assert.equal(submitted.modelConfigId, model.id);
    assert.equal(submitted.sourceUrls.length, 3);
    assert.match(submitted.prompt, /不得重新排版、移动、放大、裁切、增删或重绘图案/);
    const [composite, base, artwork] = submitted.sourceUrls.map(url => bytes.get(url.split('/')[3]));
    assert.ok(composite?.length && artwork?.length);
    assert.deepEqual(base, original, 'Base image bytes must stay unchanged through actual upload chain');
    assert.notDeepEqual(composite, original, 'Composite must include artwork rather than just original garment');
    const stored = await page.evaluate(async ({ owner, tokenUrl }) => {
        const lf = (await import('/node_modules/.vite/deps/localforage.js')).default;
        const name = `wireless-canvas:oa:user:${encodeURIComponent(owner)}`;
        const token = new URL(tokenUrl).searchParams.get('placementToken');
        return { handoff: await lf.createInstance({ name, storeName: 'placement_ai_handoffs' }).getItem(token), original: await lf.createInstance({ name, storeName: 'generation_drafts' }).getItem('image-edit:prompt') };
    }, { owner, tokenUrl });
    assert.equal(stored.handoff, null, 'Source token is consumed once');
    assert.equal(stored.original, '原图片编辑草稿，必须保留');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    await fs.writeFile(resolve(output, 'report.json'), JSON.stringify({ result: 'pass', paidCalls: 0, mockedTaskSubmissions: submissions.length, referenceCount: submitted.sourceUrls.length, originalBytesPreserved: true, separateDraftPreserved: true, tokenConsumed: true, reloadPreservedEdits: true, errors, unexpected }, null, 2));
    console.log('PASS: placement → 3 references → isolated draft → explicit real requestEdit/upload/task chain (mocked API only), reload and original draft preserved.');
} finally { await browser.close(); }
