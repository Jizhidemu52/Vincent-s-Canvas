// Real frontend and IndexedDB; every business/model endpoint is isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { verifyChatCreativeContinuity } from './chat-creative-continuity.browser.mjs';

const origin = process.env.CHAT_RELIABILITY_TEST_URL || 'http://127.0.0.1:5355';
const output = resolve(import.meta.dirname, '../../output/chat-reliability-browser');
await fs.mkdir(output, { recursive: true });
const owner = 'chat-reliability-owner';
const key = `wireless-canvas:llm-chat:${owner}`;
const imageBytes = await fs.readFile(new URL('../../labs/design-workbench/assets/garment.png', import.meta.url));
const imageData = `data:image/png;base64,${imageBytes.toString('base64')}`;
const markdown = '# 标题\n\n**加粗**与[安全链接](https://example.test)\n\n- 列表一\n- 列表二\n\n```js\nconst safe = true;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 花型 | A |\n\n<script>window.injected = true</script>\n![外部图片](https://example.test/image.png)';
const original = [
    { id: 'legacy-a', title: '旧会话甲', updatedAt: '2026-01-01', messages: [
        { id: 'original-user', role: 'user', content: '原始需求', attachments: [{ id: 'old-image', kind: 'image', name: '原稿.png', dataUrl: imageData, mimeType: 'image/png', size: imageBytes.length }], createdAt: '2026-01-01' },
        { id: 'original-answer', role: 'assistant', parentMessageId: 'original-user', content: markdown, createdAt: '2026-01-01' },
        { id: 'future-user', role: 'user', content: '之后的消息不能加入早期重放', createdAt: '2026-01-01' },
        { id: 'future-answer', role: 'assistant', parentMessageId: 'future-user', content: '之后的回复', createdAt: '2026-01-01' },
    ] },
    { id: 'legacy-b', title: '旧会话乙', updatedAt: '2026-01-01', messages: [{ id: 'other-user', role: 'user', content: '未打开的会话', attachments: [{ id: 'other-image', kind: 'image', name: '另一原稿.png', dataUrl: imageData, mimeType: 'image/png', size: imageBytes.length }], createdAt: '2026-01-01' }] },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage();
const errors = [], unexpected = [], planner = [], taskPosts = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === '/__chat-seed') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated seed</title>' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/deployment') return json({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    if (url.pathname === '/api/auth/session') return json({ user: { id: owner, username: 'isolated', displayName: '隔离回归', role: 'designer', status: 'active', mustChangePassword: false, creditBalance: 0 } });
    if (url.pathname === '/api/modules') return json({ modules: ['canvas', 'image', 'assets', 'gpt-chat', 'gpt-chat-image'].map(moduleKey => ({ moduleKey, enabled: true })) });
    if (url.pathname === '/api/models') return json({ models: [
        { id: 'chat-fixture', modelId: 'claude-sonnet-5-5', name: '隔离对话模型', capabilities: ['chat'], creditCost: 0, rmbCost: 0 },
        { id: 'image-fixture', modelId: 'gpt-image-2', name: '隔离图片模型', capabilities: ['generate', 'edit'], creditCost: 0, rmbCost: 0 },
    ], prices: [], tools: [{ toolKey: 'gpt-chat', modelConfigId: 'chat-fixture', enabled: true, configurationVersion: 1 }] });
    if (url.pathname === '/api/chat/responses') { planner.push(request.postDataJSON()); return json({ content: `分支回复 ${planner.length}`, toolCalls: [] }); }
    if (url.pathname === '/api/tasks' && request.method() === 'POST') taskPosts.push(request.postDataJSON());
    unexpected.push(`${request.method()} ${url.pathname}`); return route.fulfill({ status: 501, body: 'Unmocked API blocked' });
});
await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.testStreams = [];
    window.fetch = async (input, init) => {
        if (window.testStream && String(input).endsWith('/api/chat/responses')) {
            window.testStreams.push(JSON.parse(init.body));
            const text = '**流式已收到**\n\n后续还在等待';
            const stream = new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`));
                init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
            } });
            return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return originalFetch(input, init);
    };
    const originalExec = Document.prototype.execCommand;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { window.testCopied = value; } } });
    Document.prototype.execCommand = function(command, ...args) {
        if (command === 'copy') { window.testCopied = String(window.getSelection()); return true; }
        return originalExec.call(this, command, ...args);
    };
});
async function stored() {
    return page.evaluate(async key => {
        const { createWorkspaceStorage } = await import('/src/lib/workspace-storage.ts');
        const store = createWorkspaceStorage('app_state');
        const legacy = await store.getItem(key), index = await store.getItem(`${key}:index:v2`);
        const sessions = await Promise.all((index?.sessions || []).map(async entry => entry.recordKey ? await store.getItem(entry.recordKey) : legacy.find(item => item.id === entry.id)));
        return { legacy, index, sessions };
    }, key);
}
try {
    await page.goto(origin + '/__chat-seed');
    await page.evaluate(async ({ key, original }) => {
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('wireless-canvas', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('app_state');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const db = request.result, tx = db.transaction('app_state', 'readwrite'); tx.objectStore('app_state').put(original, key); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        });
    }, { key, original });
    await page.goto(origin + '/chat', { waitUntil: 'domcontentloaded' });
    const draft = page.getByRole('textbox', { name: '对话内容', exact: true });
    await expect(draft).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: '标题', exact: true })).toBeVisible();
    await expect(page.locator('.chat-markdown pre code')).toHaveText('const safe = true;\n');
    await expect(page.locator('.chat-markdown table')).toHaveCount(1);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('.chat-markdown img').count(), 0);
    await expect(page.locator('[data-message-id="original-user"] img')).toBeVisible();
    await expect.poll(async () => (await stored()).sessions[0]?.messages[0]?.attachments[0]?.storageKey).toMatch(/^image:/);
    let snapshot = await stored();
    assert.deepEqual(snapshot.legacy, original);
    assert.equal(snapshot.index.sessions.find(item => item.id === 'legacy-b').recordKey, undefined);
    const originalSaved = structuredClone(snapshot.sessions[0]);
    assert.equal(originalSaved.messages[0].attachments[0].dataUrl, '');
    const savedBytes = await page.evaluate(async storageKey => {
        const { getImageBlob } = await import('/src/services/image-storage.ts');
        return Array.from(new Uint8Array(await (await getImageBlob(storageKey)).arrayBuffer()));
    }, originalSaved.messages[0].attachments[0].storageKey);
    assert.equal(Buffer.from(savedBytes).equals(imageBytes), true);
    await page.locator('[data-message-id="original-answer"]').getByRole('button', { name: '复制消息', exact: true }).click();
    assert.equal(await page.evaluate(() => window.testCopied), markdown);
    await page.locator('[data-message-id="original-answer"]').getByRole('button', { name: '重新生成', exact: true }).evaluate(button => { button.click(); button.click(); });
    await expect(page.getByText('分支回复 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await stored()).sessions.length).toBe(3);
    snapshot = await stored();
    assert.deepEqual(snapshot.sessions.find(item => item.id === 'legacy-a'), originalSaved);
    assert.deepEqual(snapshot.sessions[0].branchOf, { sessionId: 'legacy-a', messageId: 'original-user' });
    assert.equal(planner.length, 1);
    assert.equal(JSON.stringify(planner[0]).includes('之后的消息不能加入早期重放'), false);
    assert.equal(snapshot.sessions[0].messages[0].attachments[0].storageKey, originalSaved.messages[0].attachments[0].storageKey);
    await page.locator('aside').getByRole('button', { name: /^原始需求 \d/ }).click();
    await page.locator('[data-message-id="original-user"]').getByRole('button', { name: '编辑消息', exact: true }).click();
    await page.locator('textarea').fill('修改后的原始需求');
    await page.getByRole('button', { name: '发送为新分支', exact: true }).click();
    await expect(page.getByText('分支回复 2', { exact: true })).toBeVisible();
    await expect.poll(async () => (await stored()).sessions.length).toBe(4);
    snapshot = await stored();
    assert.equal(snapshot.sessions[0].messages[0].content, '修改后的原始需求');
    assert.deepEqual(snapshot.sessions.find(item => item.id === 'legacy-a'), originalSaved);
    assert.equal(planner.length, 2);
    await page.evaluate(() => { window.testStream = true; });
    await draft.fill('请提供流式回答'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('流式已收到', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await stored()).sessions[0].messages.at(-1).stopped).toBe(true);
    assert.equal((await stored()).sessions[0].messages.at(-1).content, '**流式已收到**\n\n后续还在等待');
    assert.equal(await page.evaluate(() => window.testStreams.length), 1);
    await page.screenshot({ path: resolve(output, 'stopped-branch-desktop.png'), fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('流式已收到', { exact: true })).toBeVisible();
    assert.equal(planner.length, 2); assert.deepEqual(taskPosts, []);
    snapshot = await stored(); assert.deepEqual(snapshot.legacy, original);
    assert.equal(snapshot.index.sessions.find(item => item.id === 'legacy-b').recordKey, undefined);
    await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.setViewportSize({ width: 390, height: 844 });
    const close = page.locator('aside').getByRole('button', { name: '收起会话', exact: true });
    if (await close.isVisible()) await close.click();
    await expect.poll(() => page.locator('aside[aria-hidden]').evaluate(element => element.getBoundingClientRect().width <= 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(output, 'stopped-branch-dark-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const continuity = await verifyChatCreativeContinuity(page, origin, { screenshotDirectory: output });
    await fs.writeFile(resolve(output, 'continuity-result.json'), JSON.stringify(continuity, null, 2));
    assert.equal(continuity.passed, true, JSON.stringify(continuity));
    const report = { passed: true, actualModelCalls: 0, legacySnapshotUnchanged: true, unopenedSessionNotMigrated: true, originalBytesPreserved: true, mediaReferencesSharedByBranches: true, markdownSafe: true, copyExactSource: true, regenerateDoubleClickCalls: 1, editKeepsOriginal: true, stoppedStreamPreservedAfterReload: true, mobileNoOverflow: true, continuity: { passed: continuity.passed, plannerRequests: continuity.stubbedPlannerRequests, imageTasks: continuity.stubbedImageTaskPosts }, errors, unexpected };
    await fs.writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
    console.error(JSON.stringify({ errors, unexpected, plannerRequests: planner.length, pageText: (await page.locator('body').innerText()).slice(0, 5000) }));
    await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); throw error;
} finally { await context.close(); await browser.close(); }
