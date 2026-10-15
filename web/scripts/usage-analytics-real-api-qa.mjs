// Integration QA: real Chrome + production usage routers + isolated PGlite fixture.
// Start server/scripts/usage-analytics-qa.ts with --serve first. No real model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { moduleDefinitions, toolDefinitions } from '../../shared/feature-catalog.ts';

const { chromium } = createRequire(new URL('../../labs/design-workbench/package.json', import.meta.url))('playwright');
const origin = 'http://127.0.0.1:5188', api = 'http://127.0.0.1:3104';
const output = fileURLToPath(new URL('../../output/usage-analytics-real-api-qa/', import.meta.url));
await fs.mkdir(output, { recursive: true });
const ids = { admin: '10000000-0000-4000-8000-000000000001', first: '10000000-0000-4000-8000-000000000002', model: '30000000-0000-4000-8000-000000000001' };
let role = 'super_admin', person = ids.admin, detail;
const report = { scope: 'Real browser and production usage routers with isolated PostgreSQL-engine fixtures; authentication/catalog fixtures only; no real upstream calls.', calls: [], checks: [], external: [], unexpectedWrites: [], pageErrors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, acceptDownloads: true, serviceWorkers: 'block' });
await context.routeWebSocket('**/*', socket => socket.close());
const page = await context.newPage(); page.setDefaultTimeout(20_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
  if (url.origin !== origin) { report.external.push(url.origin); return route.abort('blockedbyclient'); }
  if (!url.pathname.startsWith('/api/')) return ['GET', 'HEAD'].includes(request.method()) ? route.continue() : route.abort('blockedbyclient');
  const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.pathname.startsWith('/api/admin/usage/') || url.pathname.startsWith('/api/usage/')) {
    const actual = await route.fetch({ url: api + url.pathname + url.search, headers: { ...request.headers(), 'x-qa-role': role, 'x-qa-user': person } });
    const call = { path: url.pathname, method: request.method(), status: actual.status(), role };
    report.calls.push(call);
    if (actual.status() === 200 && url.pathname.includes('/people/')) detail = (await actual.json()).data;
    if (request.method() === 'POST' && url.pathname.endsWith('/analyze')) {
      const body = request.postDataJSON(); assert.equal(body.modelConfigId, ids.model); assert.match(body.previewHash, /^[a-f0-9]{64}$/); assert.equal(body.confirm, true);
    }
    return route.fulfill({ response: actual });
  }
  if (url.pathname === '/api/deployment') return json({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: true, oaLoginEnabled: true });
  if (url.pathname === '/api/auth/session') return json({ user: { id: person, username: 'qa', displayName: role === 'super_admin' ? '隔离统计管理员' : '张三', role, status: 'active', mustChangePassword: false, creditBalance: 0, departmentId: null, groupId: null } });
  if (url.pathname === '/api/models') return json({ models: [{ id: ids.model, modelId: 'fixture-chat', name: '测试文字模型', capabilities: ['chat'], providerId: '20000000-0000-4000-8000-000000000001', protocol: 'openai-chat', enabled: true, creditCost: 0, rmbCost: 0, concurrencyLimit: 1 }], prices: [], tools: toolDefinitions.map(tool => ({ ...tool, enabled: true, modelConfigId: null, configurationVersion: 1 })) });
  if (url.pathname === '/api/modules') return json({ modules: moduleDefinitions.map(item => ({ moduleKey: item.moduleKey, enabled: true })) });
  if (!['GET', 'HEAD'].includes(request.method())) { report.unexpectedWrites.push(url.pathname); return json({ code: 'QA_BLOCKED' }, 403); }
  return json({ code: 0, data: [], users: [], departments: [], auditLogs: [], history: [], tasks: [], projects: [], documents: [], assets: [], total: 0, totalRmbCost: 0 });
});
const check = value => { report.checks.push(value); console.log(value); };
try {
  await page.goto(`${origin}/admin?tab=usage-analysis`);
  await page.getByRole('button', { name: '张三', exact: true }).waitFor();
  assert.equal(report.calls.filter(call => call.path.endsWith('/analyze')).length, 0);
  await page.getByRole('button', { name: '张三', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '张三 · 使用记录', exact: true });
  await drawer.getByText(/记录共/).waitFor();
  assert.equal(detail.person.userId, ids.first);
  assert.ok(detail.pagination.total > 1200);
  for (const name of ['个人模型调用分布', '个人板块使用分布', '个人操作控件分布']) await drawer.getByRole('region', { name, exact: true }).waitFor();
  const long = detail.records.find(record => (record.prompt?.length || 0) > 60_000);
  assert.ok(long, 'Actual API must include complete long Chinese text on the first detail page');
  const kind = long.kind === 'chat' ? '文字调用' : '生成请求';
  const article = drawer.getByRole('article', { name: `${kind} ${long.id}`, exact: true });
  await article.locator('summary').click();
  assert.equal(await article.locator('pre').first().textContent(), long.prompt);
  check('Real SQL personal charts and complete long Chinese prompt rendered without truncation.');
  await drawer.getByRole('button', { name: '导出此人完整记录', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '开始导出完整记录', exact: true }).click();
  const download = await downloadEvent; const filename = path.join(output, 'real-person-complete.jsonl');
  await download.saveAs(filename);
  const exported = (await fs.readFile(filename, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(exported[0].filters.userIds, [ids.first]);
  assert.equal(exported.at(-1).type, 'complete');
  const records = exported.filter(line => line.type === 'record').map(line => line.record);
  assert.equal(records.length, detail.pagination.total);
  assert.equal(exported.at(-1).recordCount, records.length);
  assert.ok(records.every(record => record.userId === ids.first));
  assert.equal(records.find(record => record.id === long.id).prompt, long.prompt);
  report.exportRecordCount = records.length;
  check('Browser downloaded every real SQL row, including full prompt and verified completion marker.');
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '预览将发送的汇总', exact: true }).click();
  const preview = page.getByTestId('usage-analysis-preview'); await preview.waitFor();
  const previewData = JSON.parse(await preview.textContent());
  assert.equal(previewData.promptSamples, undefined);
  assert.equal(report.calls.filter(call => call.path.endsWith('/analyze')).length, 0);
  assert.ok(!(await preview.textContent()).includes('张三'));
  await page.getByLabel('使用分析文字模型', { exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('测试文字模型', { exact: true }).click();
  await page.getByRole('button', { name: '发送已预览汇总 · 手动分析', exact: true }).click({ clickCount: 2 });
  await page.getByRole('region', { name: '使用分析结果', exact: true }).getByText(/统计显示常用文生图板块/).waitFor();
  assert.equal(report.calls.filter(call => call.path.endsWith('/analyze')).length, 1);
  check('Actual preview hash/UUID accepted by production analysis route; double click makes one fake-provider call.');
  await page.screenshot({ path: path.join(output, 'real-admin-analysis.png'), fullPage: true });
  role = 'designer'; person = ids.first;
  const adminCount = report.calls.filter(call => call.path.startsWith('/api/admin/usage')).length;
  await page.goto(`${origin}/admin?tab=usage-analysis`);
  await page.waitForLoadState('networkidle');
  assert.equal(report.calls.filter(call => call.path.startsWith('/api/admin/usage')).length, adminCount);
  const forbidden = await page.evaluate(async () => { const response = await fetch('/api/admin/usage/people'); return response.status; });
  assert.equal(forbidden, 403);
  await page.goto(`${origin}/image`);
  await page.waitForFunction(() => document.body.textContent.includes('记录业务访问'));
  await page.waitForResponse(response => response.url().endsWith('/api/usage/events') && response.status() === 200);
  const own = await page.evaluate(async () => (await (await fetch('/api/usage/me')).json()).data);
  assert.ok(own.boards.some(board => board.key === 'image' && board.count >= 2));
  check('Designer cannot enter admin usage; real collector event reaches own-only SQL aggregate.');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.unexpectedWrites, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack;
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
