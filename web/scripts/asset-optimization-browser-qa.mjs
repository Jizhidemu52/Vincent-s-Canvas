// Node 22+ only. Uses local Vite for UI assets; every API request is intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { moduleDefinitions, toolDefinitions } from '../../shared/feature-catalog.ts';

const { chromium } = createRequire(path.resolve('../labs/design-workbench/package.json'))('playwright');
const { unzipSync } = createRequire(path.resolve('package.json'))('fflate');
const origin = process.env.ASSET_QA_URL || 'http://127.0.0.1:5199';
const output = path.resolve('../output/asset-optimization-ui');
await fs.mkdir(output, { recursive: true });
const ownerId = 'local-asset-optimization-qa';
const projectId = '90000000-0000-4000-8000-000000000001';
const project = { id: projectId, externalId: 'qa-project', name: 'QA真实项目', status: 'active', createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z' };
const image = execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { windowsHide: true, timeout: 30000 });
const records = new Map(Array.from({ length: 61 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const kind = index % 3 === 0 ? 'image' : 'text';
    const bytes = kind === 'image' ? image : Buffer.from(`素材${number}的完整正文，不应出现在轻列表中。`);
    return [id, { id, ownerUserId: ownerId, ownerName: '隔离素材验证', departmentId: null, departmentName: null,
        projectId: null, projectName: null, taskId: null, filename: `本地素材${number}.${kind === 'image' ? 'png' : 'txt'}`,
        mimeType: kind === 'image' ? 'image/png' : 'text/plain', byteSize: bytes.length, kind, source: 'QA素材', operationType: null,
        prompt: kind === 'image' ? `图片${number}的完整提示词` : null, modelName: null, status: 'ready', visibilityScope: 'private',
        metadata: { title: `本地素材${number}`, tags: [index % 2 ? '蓝色' : '红色'], note: '只在详情读取的说明',
            ...(kind === 'image' ? { width: 80, height: 60 } : { content: bytes.toString() }) },
        createdAt: '2026-10-19T00:00:00.000Z', resultStatus: 'unused', usabilityScore: 0, downloadCount: 0, firstDownloadedAt: null, eventCount: 0,
        contentUrl: `/api/assets/${id}/content`, thumbnailUrl: kind === 'image' ? `/api/assets/${id}/thumb?w=256` : null,
        previewUrl: kind === 'image' ? `/api/assets/${id}/thumb?w=1024` : null, bytes, deleted: false }];
}));
const report = { scope: 'Real Chromium UI; isolated browser; local Vite only; all APIs mocked; no providers or production', checks: [], errors: [], blocked: [], lists: [], batches: [], downloads: [], screenshots: [] };
let denyId = null;
let failNextAssetPage = false;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, acceptDownloads: true, serviceWorkers: 'block' });
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on('pageerror', error => report.errors.push(error.message));
const detail = record => { const { bytes, deleted, ...asset } = record; return asset; };
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname, method = request.method();
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { report.blocked.push(request.url()); return route.abort(); }
    if (!pathname.startsWith('/api/')) return route.continue();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/api/deployment') return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (pathname === '/api/auth/session') return json({ user: { id: ownerId, username: 'asset-qa', displayName: '隔离素材验证', role: 'designer', status: 'active', mustChangePassword: false, creditBalance: 0 } });
    if (pathname === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
    if (pathname === '/api/models') return json({ models: [], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
    if (pathname === '/api/projects') return json({ projects: [project] });
    if (pathname === '/api/projects/sync') return json({ project });
    if (pathname === '/api/assets' && method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 60), q = url.searchParams.get('q') || '', kind = url.searchParams.get('kind');
        assert.ok(limit >= 1 && limit <= 200);
        if (url.searchParams.has('cursor') && failNextAssetPage) {
            failNextAssetPage = false;
            report.lists.push({ limit, q, kind, cursor: url.searchParams.get('cursor'), status: 503 });
            return json({ message: '隔离验证：下一页暂时不可用' }, 503);
        }
        const rows = [...records.values()].filter(record => !record.deleted && (!kind || kind === record.kind)
            && (!q || `${record.filename} ${record.metadata.title} ${record.metadata.tags.join(' ')} ${record.metadata.content || ''}`.includes(q)))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        let start = 0;
        if (url.searchParams.has('cursor')) { const [, id] = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()); start = rows.findIndex(row => row.id === id) + 1; }
        const selected = rows.slice(start, start + limit), hasMore = start + limit < rows.length;
        const last = selected.at(-1);
        const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null;
        report.lists.push({ limit, q, kind, cursor: url.searchParams.get('cursor'), count: selected.length, hasMore });
        return json({ assets: selected.map(record => ({ ...detail(record), canRecreate: true, prompt: null,
            metadata: { title: record.metadata.title, tags: record.metadata.tags, width: record.metadata.width, height: record.metadata.height } })), hasMore, nextCursor });
    }
    if (pathname === '/api/assets/batch' && method === 'POST') {
        const input = request.postDataJSON();
        const selected = input.assetIds.map(id => records.get(id));
        assert.ok(input.assetIds.length >= 1 && input.assetIds.length <= 50);
        const denied = input.assetIds.includes(denyId) || selected.some(record => !record || record.deleted);
        report.batches.push({ ...input, status: denied ? 403 : 200 });
        if (denied) return json({ error: 'BATCH_FORBIDDEN', message: '部分素材不存在或无权操作，整批未修改' }, 403);
        if (input.action === 'delete') selected.forEach(record => { record.deleted = true; });
        if (input.action === 'move-project') {
            assert.equal(input.projectId, projectId);
            selected.forEach(record => { record.projectId = projectId; record.projectName = project.name; });
        }
        return json({ action: input.action, assetIds: input.assetIds, count: selected.length,
            assets: ['download', 'add-to-canvas'].includes(input.action) ? selected.map(detail) : [] });
    }
    const media = pathname.match(/^\/api\/assets\/([^/]+)\/(content|thumb)$/);
    if (media) {
        const record = records.get(media[1]);
        if (!record || record.deleted) return json({ message: 'not found' }, 404);
        return route.fulfill({ status: 200, contentType: record.mimeType, body: record.bytes });
    }
    const assetId = pathname.match(/^\/api\/assets\/([^/]+)$/)?.[1];
    if (assetId && method === 'GET') {
        const record = records.get(assetId);
        return record && !record.deleted ? json({ asset: detail(record) }) : json({ message: 'not found' }, 404);
    }
    if (pathname.startsWith('/api/canvas-documents/')) {
        if (method === 'PUT') { const input = request.postDataJSON(); return json({ document: { id: pathname.split('/').at(-1), revision: (input.baseRevision || 0) + 1, deleted: false, updatedAt: new Date().toISOString() } }); }
        return json({ document: { id: pathname.split('/').at(-1), revision: 0, deleted: true, document: null, updatedAt: '1970-01-01T00:00:00.000Z' } });
    }
    if (method !== 'GET' && method !== 'HEAD') return json({ message: `Unexpected local QA write: ${pathname}` }, 500);
    return json({ code: 0, data: [], assets: [], projects: [], documents: [], history: [], tasks: [], models: [], total: 0, nextCursor: null, hasMore: false });
});

const until = async check => { const end = Date.now() + 20000; while (!await check()) { if (Date.now() > end) throw new Error('QA state condition timed out'); await new Promise(resolve => setTimeout(resolve, 60)); } };
const step = async (name, run) => { console.log(name); await run(); report.checks.push(name); };
const screenshot = async filename => { await page.screenshot({ path: path.join(output, filename), fullPage: true }); report.screenshots.push(filename); };
const checkboxes = () => page.getByRole('checkbox', { name: /^选择本地素材/ });
const checked = () => page.locator('input[type="checkbox"][aria-label^="选择本地素材"]:checked');
const activeCount = () => [...records.values()].filter(record => !record.deleted).length;
const currentCanvas = () => page.evaluate(async () => { const { readCanvasProjects } = await import('/src/lib/canvas/canvas-project-storage.ts'); return (await readCanvasProjects('wireless-canvas:canvas_store')).find(item => item.id === location.pathname.split('/').at(-1)); });
const editorReady = async () => {
    await page.getByText(/正在加载编辑区/).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '画布缩放与视图', exact: true }).waitFor();
    await page.locator('[data-node-id]').first().waitFor();
};
const confirmDelete = async () => {
    await page.getByRole('button', { name: '批量删除', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: '删除选中的' });
    await dialog.getByRole('button', { name: /^删\s*除$/ }).click();
};
const selectTarget = async name => {
    const dialog = page.getByRole('dialog');
    await dialog.locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: name }).click();
};
let existingCanvasId;
try {
    await page.goto(origin + '/assets');
    await checkboxes().first().waitFor();
    await step('actual mouse-wheel scroll loads record 61 after the default 60 without a button click', async () => {
        await page.getByText('已加载 60 个素材 · 还有更多', { exact: true }).waitFor();
        assert.equal(report.lists[0].limit, 60); assert.equal(await checkboxes().count(), 60);
        await page.locator('[aria-label="素材库"] main').hover();
        await page.mouse.wheel(0, 50000);
        await page.getByText('已加载 61 个素材', { exact: true }).waitFor();
        assert.ok(report.lists.some(item => item.cursor && item.count === 1));
        assert.equal(await checkboxes().count(), 61);
        assert.equal(await page.getByRole('button', { name: '加载更多素材', exact: true }).count(), 0);
        await screenshot('01-paginated-library.png');
    });
    await step('a failed automatic page request stays paused through repeated scrolling and one manual retry succeeds', async () => {
        await page.locator('[aria-label="素材库"] main').hover();
        await page.mouse.wheel(0, -50000);
        failNextAssetPage = true;
        await page.reload();
        await page.getByText('已加载 60 个素材 · 还有更多', { exact: true }).waitFor();
        await page.locator('[aria-label="素材库"] main').hover();
        await page.mouse.wheel(0, 50000);
        await page.getByRole('alert').filter({ hasText: '自动加载已暂停' }).waitFor();
        const attempted = report.lists.filter(item => item.cursor).length;
        assert.equal(report.lists.at(-1).status, 503);
        for (let index = 0; index < 3; index++) {
            await page.mouse.wheel(0, -50000);
            await page.waitForTimeout(150);
            await page.mouse.wheel(0, 50000);
            await page.waitForTimeout(150);
        }
        await page.waitForTimeout(2200);
        assert.equal(report.lists.filter(item => item.cursor).length, attempted);
        assert.equal(await checkboxes().count(), 60);
        await screenshot('10-failed-page-paused.png');
        await page.getByRole('button', { name: '重试加载更多素材', exact: true }).click();
        await page.getByText('已加载 61 个素材', { exact: true }).waitFor();
        assert.equal(report.lists.filter(item => item.cursor).length, attempted + 1);
        assert.equal(await checkboxes().count(), 61);
        assert.equal(await page.getByRole('alert').filter({ hasText: '自动加载已暂停' }).count(), 0);
        report.automaticPagination = { initial: 60, afterScroll: 61, failedAutoRequests: 1, retryStorm: false, manualRetryRequests: 1 };
    });
    await step('search and kind filters request scoped server pages and show matching cards', async () => {
        const search = page.getByPlaceholder('搜索标题、内容、标签或来源');
        await search.fill('本地素材061');
        await until(async () => await checkboxes().count() === 1);
        assert.equal(await checkboxes().first().getAttribute('aria-label'), '选择本地素材061');
        assert.ok(report.lists.some(item => item.q === '本地素材061' && item.count === 1));
        await search.fill('');
        await page.locator('.prompt-filter-tag').filter({ hasText: /^图片$/ }).click();
        await page.getByText('已加载 21 个素材', { exact: true }).waitFor();
        assert.ok(report.lists.some(item => item.kind === 'image' && item.count === 21));
        await screenshot('02-image-filter.png');
        await page.locator('.prompt-filter-tag').filter({ hasText: /^全部$/ }).click();
        await page.getByText('已加载 61 个素材', { exact: true }).waitFor();
    });
    await step('Shift selects a consecutive range and Ctrl+A from a focused checkbox caps selection at 50', async () => {
        await until(async () => await checkboxes().count() === 61);
        await checkboxes().nth(0).click();
        await checkboxes().nth(3).click({ modifiers: ['Shift'] });
        assert.equal(await checked().count(), 4);
        await checkboxes().nth(3).press('Control+a');
        assert.equal(await checked().count(), 50);
        await page.getByText('已选 50 / 50', { exact: true }).waitFor();
        await screenshot('03-select-fifty.png');
    });
    await step('one mixed-permission batch is rejected and leaves all 61 cards and 50 selections intact', async () => {
        denyId = [...records.values()].sort((a, b) => b.id.localeCompare(a.id))[10].id;
        const count = report.batches.length;
        await confirmDelete();
        await page.getByText('部分素材不存在或无权操作，整批未修改', { exact: true }).waitFor();
        assert.equal(report.batches.length - count, 1); assert.equal(report.batches.at(-1).assetIds.length, 50);
        assert.equal(report.batches.at(-1).status, 403); assert.equal(activeCount(), 61); assert.equal(await checked().count(), 50);
        await screenshot('04-denied-batch-preserved.png');
        denyId = null;
    });
    await step('deleting 50 selected assets issues exactly one batch request and refreshes to 11', async () => {
        const count = report.batches.length;
        await confirmDelete();
        await page.getByText('已加载 11 个素材', { exact: true }).waitFor();
        assert.equal(report.batches.length - count, 1); assert.equal(report.batches.at(-1).action, 'delete');
        assert.equal(report.batches.at(-1).assetIds.length, 50); assert.equal(activeCount(), 11); assert.equal(await checked().count(), 0);
        await screenshot('05-delete-fifty.png');
    });
    await step('ZIP download contains the selected original byte sequences and uses one authorization batch', async () => {
        for (let index = 0; index < 3; index++) await checkboxes().nth(index).click();
        const count = report.batches.length;
        const downloadPromise = page.waitForEvent('download');
        await page.getByRole('button', { name: '批量下载', exact: true }).click();
        const download = await downloadPromise;
        const filename = 'selected-originals.zip'; await download.saveAs(path.join(output, filename));
        const files = unzipSync(await fs.readFile(path.join(output, filename)));
        assert.equal(report.batches.length - count, 1); assert.equal(report.batches.at(-1).action, 'download');
        const expectedIds = report.batches.at(-1).assetIds;
        assert.equal(Object.keys(files).length, expectedIds.length);
        Object.values(files).forEach((bytes, index) => assert.deepEqual(Buffer.from(bytes), records.get(expectedIds[index]).bytes));
        report.downloads.push({ filename, entries: Object.keys(files), originalBytesVerified: true });
        await page.getByText('已打包 3 个原始文件', { exact: true }).waitFor();
        await screenshot('06-original-zip-download.png');
    });
    await step('batch insertion creates a real local canvas containing full text and original media URLs', async () => {
        await page.waitForFunction(async () => (await import('/src/stores/canvas/use-canvas-store.ts')).useCanvasStore.getState().hydrated);
        existingCanvasId = await page.evaluate(async () => {
            const { useCanvasStore, flushCanvasPersistence } = await import('/src/stores/canvas/use-canvas-store.ts');
            const id = useCanvasStore.getState().importProject({ title: 'QA已有画布', nodes: [{ id: 'qa-existing-node', type: 'text', title: '原有节点', position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: '保持原有内容' } }] });
            await flushCanvasPersistence(); return id;
        });
        const count = report.batches.length;
        await page.getByRole('button', { name: '加入画布', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: /^确\s*认$/ }).click();
        await page.waitForURL(/\/canvas\/[^/]+$/);
        await until(async () => (await currentCanvas())?.nodes.length === 3);
        const canvas = await currentCanvas();
        assert.equal(report.batches.length - count, 1); assert.equal(report.batches.at(-1).action, 'add-to-canvas');
        assert.ok(canvas.nodes.some(node => node.type === 'text' && node.metadata.content.includes('完整正文')));
        assert.ok(canvas.nodes.some(node => node.type === 'image' && /^\/api\/assets\/.+\/content$/.test(node.metadata.content)));
        assert.ok(canvas.viewport.x >= 360 && canvas.viewport.y >= 120);
        report.newCanvas = { id: canvas.id, nodeCount: canvas.nodes.length, viewport: canvas.viewport };
        await editorReady();
        await screenshot('07-new-canvas-with-assets.png');
        await page.goto(origin + '/assets'); await until(async () => await checkboxes().count() === 11);
    });
    await step('move-to-project chooser submits the selected real project UUID once and updates both records', async () => {
        for (let index = 0; index < 2; index++) await checkboxes().nth(index).click();
        const count = report.batches.length;
        await page.getByRole('button', { name: '移动到项目', exact: true }).click();
        await selectTarget('QA真实项目');
        await page.getByRole('dialog').getByRole('button', { name: /^确\s*认$/ }).click();
        await page.getByText('已移动 2 个素材', { exact: true }).waitFor();
        assert.equal(report.batches.length - count, 1); assert.equal(report.batches.at(-1).projectId, projectId);
        report.batches.at(-1).assetIds.forEach(id => assert.equal(records.get(id).projectId, projectId));
        assert.equal(await checked().count(), 0);
        await screenshot('08-project-move.png');
    });
    await step('batch insertion into an existing canvas preserves its old node and appends two new nodes', async () => {
        for (let index = 0; index < 2; index++) await checkboxes().nth(index).click();
        const count = report.batches.length;
        await page.getByRole('button', { name: '加入画布', exact: true }).click();
        await selectTarget('QA已有画布');
        await page.getByRole('dialog').getByRole('button', { name: /^确\s*认$/ }).click();
        await page.waitForURL(`${origin}/canvas/${existingCanvasId}`);
        await until(async () => (await currentCanvas())?.nodes.length === 3);
        const canvas = await currentCanvas();
        assert.equal(report.batches.length - count, 1);
        assert.equal(canvas.nodes.find(node => node.id === 'qa-existing-node').metadata.content, '保持原有内容');
        assert.deepEqual(canvas.viewport, { x: 0, y: 0, k: 1 });
        report.existingCanvas = { id: canvas.id, nodeCount: canvas.nodes.length };
        await editorReady();
        await screenshot('09-existing-canvas-preserved.png');
    });
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
} catch (error) {
    report.status = 'failed'; report.failure = String(error); report.location = page.url();
    report.canvas = await currentCanvas().then(canvas => canvas ? { id: canvas.id, nodeCount: canvas.nodes.length } : null).catch(() => null);
    report.canvasStore = await page.evaluate(async () => { const { useCanvasStore } = await import('/src/stores/canvas/use-canvas-store.ts'); const store = useCanvasStore.getState(); return { hydrated: store.hydrated, projects: store.projects.map(item => ({ id: item.id, title: item.title, nodeCount: item.nodes.length })) }; }).catch(() => null);
    await screenshot('failure.png').catch(() => undefined);
    await fs.writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
    process.exitCode = 1;
} finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, lists: report.lists.length, batches: report.batches.map(item => ({ action: item.action, count: item.assetIds.length, status: item.status })) }, null, 2));
    await context.close(); await browser.close();
}
