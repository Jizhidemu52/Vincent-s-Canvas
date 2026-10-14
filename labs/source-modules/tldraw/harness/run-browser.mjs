import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logs = [], results = [], pageErrors = [], consoleErrors = [], network = [];
const log = message => { logs.push(message); console.log(message); };
const git = args => spawnSync('git', ['-C', path.join(root, 'upstream'), ...args], { encoding: 'utf8' }).stdout.trim();
const commit = git(['rev-parse', 'HEAD']);
const beforeStatus = git(['status', '--porcelain']);
const templatePath = path.join(root, 'upstream', 'templates', 'image-pipeline');
async function hashes(dir, prefix = '') {
 const entries = [];
 for (const item of await readdir(dir, { withFileTypes: true })) {
  if (item.name === 'node_modules' || item.name === '.vite') continue;
  const rel = path.join(prefix, item.name).replaceAll('\\', '/'), abs = path.join(dir, item.name);
  if (item.isDirectory()) entries.push(...await hashes(abs, rel));
  else entries.push({ path: rel, sha256: createHash('sha256').update(await readFile(abs)).digest('hex') });
 }
 return entries;
}
const sourceHashes = await hashes(templatePath);
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const source = {
 repository: 'https://github.com/tldraw/tldraw', commit, templatePath: 'templates/image-pipeline',
 upstreamWorkingTreeBefore: beforeStatus,
 originalSourceHashes: sourceHashes,
 actualImports: ['src/execution/ExecutionGraph.tsx', 'src/execution/executionState.ts', 'src/nodes/nodePorts.tsx', 'src/nodes/nodeTypes.tsx', 'src/nodes/types/GenerateNode.tsx', 'src/nodes/types/IteratorNode.tsx', 'src/nodes/types/CaptureNode.tsx', 'src/ports/portCompatibility.ts', 'src/connection/ConnectionBindingUtil.tsx'],
 runtime: { node: process.version, sdk: lock.packages['node_modules/tldraw'].version, assets: lock.packages['node_modules/@tldraw/assets'].version, react: lock.packages['node_modules/react'].version, vite: lock.packages['node_modules/vite'].version },
 presentationOverlay: { translation: 'harness/chinese-ui-plugin.mjs', originalSourceFilesModified: false, assets: 'Official @tldraw/assets 5.5.2 served locally via /__lab/assets; system UI font replaces Google Fonts', sdkLocale: 'zh-cn', licenseNotice: 'Original English hard-coded SDK notice preserved with Chinese explanation', transformedSourceEvidence: 'evidence/chinese-build-transforms.json', executorIntegrityEvidence: 'evidence/chinese-ui-audit.json' },
 boundary: { original: ['App.tsx and React UI', 'tldraw Editor / reactive Store / createComputedCache', 'ExecutionGraph and startExecution / stopExecution', 'port definitions, bindings, typed matching, value resolution', 'actual registered node execute functions', 'CaptureNode plus real Editor.toImage'], mocked: ['HTTP /api/* model endpoints only, fulfilled by local Vite middleware'], notMocked: ['Editor', 'node executors', 'port caches', 'bindings', 'browser IndexedDB'], notRun: ['Cloudflare Worker / R2 deployment', 'Replicate or other paid provider inference', 'SDK built from monorepo source; npm tldraw@5.5.2 is used instead'] },
 licenseFiles: ['upstream/LICENSE.md', 'upstream/templates/image-pipeline/package.json', 'upstream/templates/image-pipeline/README.md'],
};
await writeFile(path.join(evidence, 'source-provenance.json'), JSON.stringify(source, null, 2));
let ownedServer = null;
try { await fetch('http://127.0.0.1:4332/__lab/state'); }
catch {
 ownedServer = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
 ownedServer.stdout.on('data', data => logs.push(`[vite] ${data}`)); ownedServer.stderr.on('data', data => logs.push(`[vite:error] ${data}`));
 for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:4332/__lab/state'); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('request', req => network.push({ method: req.method(), url: req.url().slice(0, 250), resourceType: req.resourceType() }));
await page.route('**/*', async route => {
 const url = new URL(route.request().url());
 if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
 return route.abort('blockedbyclient');
});
const harnessUrl = '/@fs/' + path.join(root, 'harness', 'browser-scenarios.ts').replaceAll('\\', '/');
try {
 await page.goto('http://127.0.0.1:4332/');
 await page.waitForFunction(() => Boolean(window.editor), null, { timeout: 30000 });
 await page.evaluate(async url => { window.labHarness = await import(url); }, harnessUrl);
 log(`Original source commit ${commit}; original Editor mounted; SDK ${source.runtime.sdk}`);
 const initial = await page.evaluate(() => ({ title: document.title, shapes: window.editor.getCurrentPageShapes().length, connections: window.editor.getCurrentPageShapes().filter(s => s.type === 'connection').length, licenseNotice: [...document.querySelectorAll('button,a')].map(x => x.textContent).find(x => x?.includes('Get a license for production')) || null }));
 results.push({ name: 'original-app-mount', status: 'PASS', detail: initial });
 await page.evaluate(() => window.labHarness.setupConnectedFixture());
 await page.locator('.PipelineRegion-button').waitFor();
 await page.locator('.PipelineRegion-button').click();
 await page.waitForFunction(() => window.editor.getShape(window.labFixture.preview).props.node.lastImageUrl !== null, null, { timeout: 15000 });
 const uiResult = await page.evaluate(() => window.labHarness.verifyConnectedUiRun());
 results.push({ name: 'original-ui-run-ordered-multi-inputs', status: 'PASS', detail: uiResult });
 log('PASS original UI region button → original startExecution → original nodes → local API stub → original Preview');
 await page.screenshot({ path: path.join(evidence, 'original-template-connected.png') });
 const cases = ['port-contract', 'diamond-join', 'downstream-reuse-and-staleness', 'rerun-and-no-result-cache', 'failure-state-and-sibling', 'stop-does-not-cancel-inflight', 'overlap-late-write', 'failure-rerun', 'iterator-last-only', 'capture-real-editor'];
 for (const name of cases) {
  const started = Date.now();
  try {
   const detail = await page.evaluate(name => window.labHarness.runCase(name), name);
   if (detail.captureUrl) { await writeFile(path.join(evidence, 'real-editor-capture.png'), Buffer.from(detail.captureUrl.split(',')[1], 'base64')); delete detail.captureUrl; }
   results.push({ name, status: detail.gap ? 'OBSERVED_GAP' : 'PASS', assertionStatus: 'PASS', elapsedMs: Date.now() - started, detail });
   log(`${detail.gap ? 'OBSERVED_GAP' : 'PASS'} ${name}: ${detail.gap || detail.note || 'original-module assertions passed'}`);
  } catch (error) {
   results.push({ name, status: 'HARNESS_FAILURE', elapsedMs: Date.now() - started, error: error.stack || String(error) }); log(`HARNESS_FAILURE ${name}: ${error.message}`);
  }
 }
 await page.screenshot({ path: path.join(evidence, 'original-template-capture-path.png') });
} catch (error) {
 results.push({ name: 'browser-entry-or-ui-flow', status: 'HARNESS_FAILURE', error: error.stack || String(error) }); log(`HARNESS_FAILURE browser entry or UI flow: ${error.message}`);
} finally {
 source.upstreamWorkingTreeAfter = git(['status', '--porcelain']);
 await writeFile(path.join(evidence, 'source-provenance.json'), JSON.stringify(source, null, 2));
 const report = {
  runAt: new Date().toISOString(), source, summary: { scenarios: results.length, passed: results.filter(r => r.status === 'PASS').length, observedGaps: results.filter(r => r.status === 'OBSERVED_GAP').length, harnessFailures: results.filter(r => r.status === 'HARNESS_FAILURE').length, modelProviderCalls: 0 },
  results, pageErrors, consoleErrors, networkPolicy: 'Only localhost plus data/blob URLs allowed by browser route. All external hosts blocked; /api/* terminated locally. Official assets served locally. No provider credentials configured.',
  scopeWarning: 'Actual original UI/Editor/execution/ports/nodes are running. All model images are explicitly labeled deterministic local SVG fixtures. This is not real model quality validation or Cloudflare/R2 deployment validation.',
 };
 await writeFile(path.join(evidence, `run-${stamp}.json`), JSON.stringify(report, null, 2));
 await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
 await writeFile(path.join(evidence, 'network.json'), JSON.stringify(network, null, 2));
 await writeFile(path.join(evidence, `run-${stamp}.log`), logs.join('\n'));
 await writeFile(path.join(evidence, 'latest.log'), logs.join('\n'));
 log(JSON.stringify(report.summary));
 await browser.close(); ownedServer?.kill();
 if (report.summary.harnessFailures) process.exitCode = 1;
}
