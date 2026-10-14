import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

process.env.LANGSMITH_TRACING = 'false';
process.env.LANGCHAIN_TRACING_V2 = 'false';
const root = import.meta.dir;
const qa = path.join(root, 'qa');
await mkdir(qa, { recursive: true });
const networkAttempts: string[] = [];
globalThis.fetch = (async (input: any) => { networkAttempts.push(String(input)); throw new Error('Network disabled in source test'); }) as typeof fetch;
const { createBrandKitTool } = await import('./loomic-source/apps/server/src/agent/tools/brand-kit.ts');
const sdk = await import('./sdk-source/plugins/canvas/sdk/src/index.ts');
const jsx = await import('./sdk-source/plugins/canvas/sdk/src/jsx-runtime.ts');
const report: any = { checkedAt: new Date().toISOString(), tests: [], findings: [], networkAttempts, sources: {
  loomic: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'loomic-source'), encoding: 'utf8' }).trim(),
  sdk: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(root, 'sdk-source'), encoding: 'utf8' }).trim(),
}, boundaries: { actual: ['Loomic createBrandKitTool and LangChain tool.invoke', 'SDK runtime/definePlugin/JSX bridge and real React render'], substituted: ['Supabase DB/storage client is an in-memory adapter with a query log', 'SDK host runtime injected by this harness'], notTested: ['Supabase auth/RLS/storage service', 'LLM selection or generation', 'Full infinite-canvas host and its persistence'] } };
async function check(name: string, body: () => any) {
  try { await body(); report.tests.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error: any) { report.tests.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture(overrides: any = {}) {
  const calls: any[] = [];
  const kit = overrides.kit === undefined ? { id: 'kit-fixture', name: 'Garden 2027', guidance_text: '保留短袖廓形；花朵只用于胸前；不得添加口袋。' } : overrides.kit;
  const assets = overrides.assets === undefined ? [
    { asset_type: 'color', display_name: '鼠尾草绿', text_content: '#7d9275', role: 'primary' },
    { asset_type: 'font', display_name: 'Body', text_content: 'Arial', role: 'body', metadata: null },
    { asset_type: 'logo', display_name: 'Garden', file_url: 'fixture/logo.png', role: 'chest' },
    { asset_type: 'image', display_name: '结构参考', file_url: 'fixture/garment.png', role: 'silhouette' },
    { asset_type: 'image', display_name: '面料参考', file_url: 'fixture/fabric.png', role: 'material' },
  ] : overrides.assets;
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return {
        select(fields: string) { calls.push(['select', table, fields]); return this; },
        eq(key: string, value: string) { calls.push(['eq', table, key, value]); return this; },
        async maybeSingle() { return { data: structuredClone(kit), error: overrides.kitError ?? null }; },
        async order(key: string, options: any) { calls.push(['order', table, key, options]); return { data: structuredClone(assets), error: overrides.assetsError ?? null }; },
      };
    },
    storage: { from(bucket: string) { return { async createSignedUrls(paths: string[], seconds: number) {
      calls.push(['sign', bucket, paths, seconds]);
      return { data: overrides.signFailed ? null : paths.map(p => ({ path: p, signedUrl: 'https://fixture.invalid/signed/' + p })), error: overrides.signFailed ? { message: 'fixture storage unavailable' } : null };
    } }; } },
  };
  const tool = createBrandKitTool({ createUserClient(token: string) { calls.push(['client', token]); return client; } }, 'kit-fixture');
  const invoke = async () => JSON.parse(await tool.invoke({}, { configurable: { access_token: 'fixture-token-not-a-credential' } }) as string);
  return { calls, tool, invoke };
}

await check('Loomic: no token fails before touching the DB adapter', async () => {
  const f = fixture(); assert.deepEqual(JSON.parse(await f.tool.invoke({}) as string), { error: 'No access token available' }); assert.equal(f.calls.length, 0);
});
await check('Loomic: missing kit returns explicit error, no asset fetch', async () => {
  const f = fixture({ kit: null }); assert.equal((await f.invoke()).error, 'Brand kit not found'); assert.equal(f.calls.filter(c => c[0] === 'from').length, 1);
});
await check('Loomic: real tool preserves guidance/colors/font default and signs exact assets', async () => {
  const f = fixture(); const result = await f.invoke();
  assert.match(result.design_guidance, /不得添加口袋/); assert.deepEqual(result.colors, [{ name: '鼠尾草绿', hex: '#7d9275', role: 'primary' }]);
  assert.equal(result.fonts[0].weight, '400'); assert.equal(result.logos[0].role, 'chest');
  assert.equal(result.images[0].url, 'https://fixture.invalid/signed/fixture/garment.png');
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'brand_kits' && c[2] === 'id' && c[3] === 'kit-fixture'));
  assert.ok(f.calls.some(c => c[0] === 'order' && c[2] === 'sort_order' && c[3].ascending));
  assert.equal(f.calls.find(c => c[0] === 'sign')[3], 3600);
  await writeFile(path.join(qa, 'loomic-real-output.json'), JSON.stringify({ result, queryLog: f.calls }, null, 2));
});
await check('Loomic: null asset response produces empty lists', async () => {
  const r = await fixture({ assets: null }).invoke(); assert.deepEqual([r.colors, r.fonts, r.logos, r.images], [[], [], [], []]);
});
await check('Loomic finding: image reference roles are absent in actual output', async () => {
  const r = await fixture().invoke(); assert.equal(r.images[0].role, undefined); assert.equal(r.images[1].role, undefined);
  report.findings.push({ module: 'Loomic', id: 'image-role-loss', observed: 'image assets have role in DB input but output keeps only name/url', impact: 'Cannot yet rely on this tool to retain separate silhouette/material reference roles.' });
});
await check('Loomic finding: signed URL service failure leaves raw storage paths', async () => {
  const r = await fixture({ signFailed: true }).invoke(); assert.equal(r.images[0].url, 'fixture/garment.png'); assert.equal(r.error, undefined);
  report.findings.push({ module: 'Loomic', id: 'sign-failure-not-reported', observed: 'Storage error is ignored and raw object path is returned as url', impact: 'Needs failure handling before a downstream model consumes image references.' });
});
await check('Loomic finding: DB failure and missing kit share the same response', async () => {
  const r = await fixture({ kit: null, kitError: { message: 'fixture database outage' } }).invoke(); assert.equal(r.error, 'Brand kit not found');
  report.findings.push({ module: 'Loomic', id: 'db-error-misclassified', observed: 'DB outage is reported as missing kit', impact: 'Needs error distinction for useful retry and user feedback.' });
});

await check('SDK: source imports before host runtime; early runtime use fails clearly', () => {
  delete (globalThis as any).InfiniteCanvasRuntime; assert.throws(() => sdk.getRuntime(), /运行时未就绪/);
});
await check('SDK: exact host React instance and JSX/Fragment render via real React', () => {
  (globalThis as any).InfiniteCanvasRuntime = { React, version: 'fixture-host', jsx: React.createElement, Fragment: React.Fragment };
  assert.equal(sdk.getReact(), React);
  const element = jsx.jsxs(jsx.Fragment, { children: [jsx.jsx('span', { children: '源模块' }, 'one'), jsx.jsx('b', { children: '<unsafe>' }, 'two')] });
  assert.equal(renderToStaticMarkup(element), '<span>源模块</span><b>&lt;unsafe&gt;</b>');
});
await check('SDK: definePlugin object/factory identity and current runtime re-resolution', () => {
  const plugin: any = { id: 'fixture', name: 'Test', version: '1', nodes: [] }; assert.equal(sdk.definePlugin(plugin), plugin);
  const factory: any = () => plugin; assert.equal(sdk.definePlugin(factory), factory);
  const next = { React, version: 'new-host' }; (globalThis as any).InfiniteCanvasRuntime = next; assert.equal(sdk.getRuntime(), next);
});
await check('SDK finding: definePlugin is type-only help, not runtime validation', () => {
  const invalid: any = { id: '../../invalid' }; assert.equal(sdk.definePlugin(invalid), invalid);
  report.findings.push({ module: 'SDK', id: 'not-runtime-validation', observed: 'definePlugin returns its input without validation', impact: 'The SDK alone does not validate plugins or sandbox their code; host validation remains required.' });
});
await check('No external network during execution', () => assert.deepEqual(networkAttempts, []));
report.passed = report.tests.every((t: any) => t.passed);
report.count = report.tests.length;
report.businessAcceptance = 'partial_not_ready_to_copy_unchanged';
report.sourceFiles = [];
for (const [checkout, files] of [
  ['loomic-source', ['apps/server/src/agent/tools/brand-kit.ts']],
  ['sdk-source', ['plugins/canvas/sdk/src/runtime.ts', 'plugins/canvas/sdk/src/define-plugin.ts', 'plugins/canvas/sdk/src/jsx-runtime.ts', 'plugins/canvas/sdk/build.mjs', 'plugins/canvas/sticky-note/src/index.tsx']],
] as const) {
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', ...files], { cwd: path.join(root, checkout) });
  for (const file of files) report.sourceFiles.push({ checkout, file, unchangedFromCommit: true, sha256: createHash('sha256').update(await readFile(path.join(root, checkout, file))).digest('hex') });
}
await writeFile(path.join(qa, 'source-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, count: report.count, findings: report.findings.length, sources: report.sources }));
if (!report.passed) process.exitCode = 1;
