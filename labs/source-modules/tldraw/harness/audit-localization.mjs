import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { translateSource, uiWords } from './chinese-ui-plugin.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceDir = path.join(root, 'upstream/templates/image-pipeline/src/nodes/types');
const executorChecks = [];
for (const name of await readdir(sourceDir)) {
 if (!name.endsWith('Node.tsx')) continue;
 const abs = path.join(sourceDir, name), before = await readFile(abs, 'utf8'), after = translateSource(before, abs);
 const pattern = /\n\tasync execute\([\s\S]+?(?=\n\tgetOutputInfo\()/;
 const original = before.match(pattern)?.[0], translated = after.match(pattern)?.[0];
 if (original !== translated) throw new Error(`Executor changed: ${name}`);
 executorChecks.push({ file: name, executeUnchanged: true, sha256: original ? createHash('sha256').update(original).digest('hex') : null });
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
const blockedExternal = [], pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.route('**/*', route => {
 const url = new URL(route.request().url());
 if (['127.0.0.1','localhost'].includes(url.hostname) || ['data:','blob:'].includes(url.protocol)) return route.continue();
 blockedExternal.push(url.href); return route.abort();
});
await page.goto('http://127.0.0.1:4332/'); await page.waitForFunction(() => Boolean(window.editor));
await page.getByRole('button', { name: '查看全部节点', exact: true }).click();
await page.waitForFunction(() => window.editor.getCurrentPageShapes().filter(s => s.type === 'node').length === 17);
await page.waitForFunction(() => document.querySelectorAll('.NodeShape').length === 17);
const panels = await page.locator('.NodeShape').allTextContents();
const panelText = panels.join('\n');
const untranslated = Object.keys(uiWords).filter(en => /^[A-Z]/.test(en) && new RegExp(`(^|[^A-Za-z])${en.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^A-Za-z]|$)`).test(panelText)).filter(en => !['IP-Adapter','ControlNet','CFG'].includes(en));
// Default user sample text is data; technical provider/model IDs and SVG/PNG units are intentionally unchanged.
const audit = { checkedAt: new Date().toISOString(), title: await page.title(), locale: await page.evaluate(() => window.editor.user.getLocale()), nodeCount: panels.length, panels, untranslatedUiWords: untranslated, executorChecks, blockedExternal, pageErrors,
 licenseException: { text: 'Get a license for production', source: 'node_modules/@tldraw/editor/src/lib/license/Watermark.tsx:76', reason: 'Hard-coded SDK license notice, not a translation key; retained verbatim with adjacent Chinese explanation.' } };
await page.screenshot({ path: path.join(root, 'evidence/chinese-all-node-panels.png') });
await page.getByRole('button', { name: '实测结果', exact: true }).click();
await page.screenshot({ path: path.join(root, 'evidence/chinese-results-panel.png') });
await writeFile(path.join(root, 'evidence/chinese-ui-audit.json'), JSON.stringify(audit, null, 2));
await writeFile(path.join(root, `evidence/chinese-ui-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(audit, null, 2));
await browser.close();
console.log(JSON.stringify({ locale: audit.locale, nodes: audit.nodeCount, untranslatedUiWords: untranslated, unchangedNodeExecutors: executorChecks.length, blockedExternal, pageErrors }));
if (untranslated.length || audit.locale !== 'zh-cn' || audit.nodeCount !== 17 || blockedExternal.length || pageErrors.length) process.exitCode = 1;
