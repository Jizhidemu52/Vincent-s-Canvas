// Offline production UI smoke comparison. No live account, server or model calls.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../output/architecture-lab');
const origin = 'http://127.0.0.1:3001';
const variants = process.argv.includes('--candidate-only') ? ['candidate'] : ['baseline', 'candidate'];
const hash = value => createHash('sha256').update(value).digest('hex');
const user = { id: 'qa', username: 'qa', displayName: 'QA', role: 'super_admin', status: 'active', mustChangePassword: false, creditBalance: 1000 };

async function readProject(page, variant) {
    return page.evaluate(variant => new Promise((resolve, reject) => {
        const request = indexedDB.open('wireless-canvas');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result, tx = db.transaction('app_state');
            const key = variant === 'baseline' ? 'wireless-canvas:canvas_store' : JSON.stringify(['wireless-canvas:canvas_store:project-documents:v1', 'ui-0']);
            const read = tx.objectStore('app_state').get(key);
            read.onsuccess = () => { const value = JSON.parse(read.result); resolve(variant === 'baseline' ? value.state.projects.find(p => p.id === 'ui-0') : value); };
            tx.oncomplete = () => db.close();
        };
    }), variant);
}

async function waitSaved(page, variant, predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const project = await readProject(page, variant);
        if (predicate(project)) return project;
        await page.waitForTimeout(100);
    }
    throw new Error('UI edit did not persist: ' + JSON.stringify(await readProject(page, variant)).slice(0, 600));
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const results = [];
    try {
        for (const variant of variants) {
            const dist = variant === 'candidate' && process.env.CANVAS_CANDIDATE_DIST ? path.resolve(process.env.CANVAS_CANDIDATE_DIST) : path.join(root, variant);
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
            const errors = [];
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                if (url.pathname === '/__seed__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/__lab.js"></script>' });
                if (url.pathname === '/__lab.js') return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, variant + '.js')) });
                if (url.pathname.startsWith('/api/')) {
                    let body = {};
                    if (url.pathname === '/api/auth/session') body = { user };
                    else if (url.pathname === '/api/deployment') body = { authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: true };
                    else if (url.pathname === '/api/modules') body = { modules: ['canvas', 'assets', 'image', 'prompts', 'video', 'gpt-chat'].map(moduleKey => ({ moduleKey, enabled: true })) };
                    else if (url.pathname === '/api/models') body = { models: [], prices: [], tools: [] };
                    else if (url.pathname === '/api/assets') body = { assets: [] };
                    else if (url.pathname === '/api/tasks') body = { tasks: [] };
                    else if (url.pathname.endsWith('/projects')) body = { projects: [] };
                    else if (url.pathname.endsWith('/departments')) body = { departments: [] };
                    return route.fulfill({ json: body });
                }
                const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
                if (!file.startsWith(dist + path.sep)) return route.abort();
                const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html');
                return route.fulfill({ contentType: { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(target)] || 'text/html', body: fs.readFileSync(target) });
            });
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(origin + '/__seed__');
            await page.waitForFunction(() => window.architectureLab?.store.persist.hasHydrated());
            const original = await page.evaluate(async () => {
                const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 320;
                const ctx = canvas.getContext('2d');
                for (let x = 0; x < 640; x += 8) { ctx.fillStyle = `rgba(${x % 256},80,180,${x % 16 ? 0.4 : 1})`; ctx.fillRect(x, 0, 4, 320); }
                const image = canvas.toDataURL('image/png');
                const projects = Array.from({ length: 10 }, (_, p) => ({
                    id: `ui-${p}`, title: `架构实验 ${p}`, createdAt: '2026-01-01', updatedAt: '2026-01-01',
                    backgroundMode: 'dots', showImageInfo: false, viewport: { x: 450, y: 150, k: 1 }, activeChatId: null,
                    chatSessions: [{ id: 'chat', title: '完整对话', createdAt: 'old', updatedAt: 'old', messages: [{ id: 'message', role: 'user', text: '保留原文与参考图', references: [] }] }],
                    nodes: Array.from({ length: 500 }, (_, n) => ({ id: `n-${n}`, type: n ? 'text' : 'image', title: `节点 ${n}`, position: { x: (n % 25) * 800, y: Math.floor(n / 25) * 500 }, width: n ? 320 : 640, height: 320, metadata: n ? { content: `完整文本 ${n} ` + '原始内容'.repeat(100) } : { content: image, naturalWidth: 640, naturalHeight: 320, status: 'success', originalFileName: 'alpha-original.png' } })),
                    connections: Array.from({ length: 499 }, (_, n) => ({ id: `edge-${n}`, fromNodeId: `n-${n}`, toNodeId: `n-${n + 1}` })),
                }));
                window.architectureLab.store.getState().replaceProjects(projects);
                await window.architectureLab.flush();
                return projects[0];
            });
            await page.goto(origin + '/canvas/ui-0');
            const node = page.locator('[data-node-id="n-0"]');
            await node.waitFor();
            await page.waitForFunction(() => { const image = document.querySelector('[data-node-id="n-0"] img'); return image?.complete && image.naturalWidth === 640; });
            if (await page.getByLabel('收起创建面板', { exact: true }).count()) await page.getByLabel('收起创建面板', { exact: true }).click();
            await page.mouse.move(1400, 950); await page.waitForTimeout(600);
            const before = await node.screenshot({ path: path.join(root, variant + '-image.png'), animations: 'disabled' });
            const rect = await node.boundingBox();
            await page.mouse.move(rect.x + 120, rect.y + 120); await page.mouse.down();
            await page.mouse.move(rect.x + 200, rect.y + 160, { steps: 15 }); await page.mouse.up();
            const moved = await waitSaved(page, variant, p => p.nodes[0].position.x === 80 && p.nodes[0].position.y === 40);
            await page.keyboard.press('Control+z');
            await waitSaved(page, variant, p => p.nodes[0].position.x === 0 && p.nodes[0].position.y === 0);
            await page.keyboard.press('Control+Shift+z');
            await waitSaved(page, variant, p => p.nodes[0].position.x === 80 && p.nodes[0].position.y === 40);
            await page.reload(); await node.waitFor();
            await page.waitForFunction(() => { const image = document.querySelector('[data-node-id="n-0"] img'); return image?.complete && image.naturalWidth === 640; });
            const restored = await readProject(page, variant);
            assert.deepEqual(restored.nodes, moved.nodes);
            assert.deepEqual(restored.connections, original.connections);
            assert.deepEqual(restored.chatSessions, original.chatSessions);
            const imageBytes = await page.evaluate(async () => {
                const response = await fetch(document.querySelector('[data-node-id="n-0"] img').src);
                return Array.from(new Uint8Array(await response.arrayBuffer()));
            });
            assert.deepEqual(Buffer.from(imageBytes), Buffer.from(original.nodes[0].metadata.content.split(',')[1], 'base64'));
            assert.deepEqual(errors, []);
            results.push({ variant, dragUndoRedoReload: true, nodes: restored.nodes.length, connections: restored.connections.length, imageBytesSha256: hash(Buffer.from(imageBytes)), imageScreenshotSha256: hash(before), errors });
            await context.close();
        }
        if (results.length === 2) assert.equal(results[0].imageScreenshotSha256, results[1].imageScreenshotSha256, 'Resting rendered image differs');
        const report = { browser: browser.version(), status: 'PASS', fixture: '10 projects × 500 nodes, normal production route', results };
        fs.writeFileSync(path.join(root, 'ui-results.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
