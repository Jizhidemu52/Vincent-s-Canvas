/* Offline, real-Chrome/IndexedDB A/B benchmark. No HTTP server or live API. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const output = path.resolve(__dirname, '../../output/architecture-lab');
const origin = 'http://127.0.0.1:39761';
const quick = process.argv.includes('--quick');
const qualityOnly = process.argv.includes('--quality-only');
const fixtureSizes = quick ? [[1, 500], [10, 500]] : [[1, 500], [10, 500], [30, 500], [1, 2000], [10, 2000], [30, 2000]];
// Four measured trials per variant: ABBA followed by BAAB.
const order = quick ? ['baseline', 'candidate', 'candidate', 'baseline'] : ['baseline', 'candidate', 'candidate', 'baseline', 'candidate', 'baseline', 'baseline', 'candidate'];
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="420"><rect width="320" height="420" fill="#faf3e7"/><path d="M80 60H240V360H80Z" fill="#8b2942"/></svg>');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const bundles = Object.fromEntries(['baseline', 'candidate'].map(variant => {
    const file = path.join(output, `${variant}.js`);
    assert(fs.existsSync(file), `Missing ${file}; build the production harness first.`);
    return [variant, fs.readFileSync(file, 'utf8')];
}));

function fixtures(projectCount, nodeCount) {
    return Array.from({ length: projectCount }, (_, p) => {
        const nodes = Array.from({ length: nodeCount }, (_, n) => ({
            id: `p${p}-n${n}`, type: n % 5 === 0 ? 'image' : 'text', title: `设计原稿 ${p}-${n}`,
            position: { x: (n % 25) * 480, y: Math.floor(n / 25) * 350 }, width: 320, height: n % 5 === 0 ? 420 : 220,
            metadata: n % 5 === 0
                ? { content: image, storageKey: `image:fixture-${p}-${n}`, mimeType: 'image/svg+xml', naturalWidth: 320, naturalHeight: 420, originalFileName: `scarf-${p}-${n}.svg`, imageVersion: 3, prompt: '保留花纹、版型、流苏，仅修改酒红配色', status: 'idle' }
                : { content: `设计要求 ${p}-${n}：` + 'Keep original motif, stitch construction, material and silhouette. 保留原稿工艺与完整文字；'.repeat(5), fontSize: 14, status: 'idle' },
        }));
        return {
            id: `project-${p}`, title: `设计项目 ${p}`, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
            nodes, connections: nodes.flatMap((node, n) => [1, 25].map((delta, i) => ({ id: `p${p}-c${n}-${i}`, fromNodeId: node.id, toNodeId: nodes[(n + delta) % nodes.length].id }))),
            chatSessions: [{ id: `chat-${p}`, title: '客户改款记录', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', messages: [{ id: `message-${p}`, role: 'user', text: '三个配色方向，原稿不替换；保留可追溯版本。', attachments: [{ id: `reference-${p}`, type: 'image', url: image, storageKey: `image:fixture-${p}-0` }] }] }],
            activeChatId: `chat-${p}`, backgroundMode: 'dots', showImageInfo: true, viewport: { x: 80, y: 80, k: 1 },
        };
    });
}

async function bootstrap(page) {
    await page.waitForFunction(() => window.architectureLab?.store?.persist?.hasHydrated());
    await page.evaluate(() => {
        window.labEqual = function equal(a, b) {
            if (Object.is(a, b)) return true;
            if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
            if (Array.isArray(a) !== Array.isArray(b)) return false;
            const keys = Object.keys(a);
            return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
        };
        const probe = window.labProbe = { active: false, puts: [], gaps: [], longTasks: [], failNext: false, failAfterPuts: null };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, ...args) {
            if (probe.failNext) { probe.failNext = false; throw new DOMException('Architecture lab injected quota failure', 'QuotaExceededError'); }
            if (probe.failAfterPuts !== null && probe.failAfterPuts-- === 0) { probe.failAfterPuts = null; throw new DOMException('Architecture lab injected multi-write quota failure', 'QuotaExceededError'); }
            if (probe.active) {
                probe.puts.push({ store: this.name, key: String(args[0] ?? ''), value });
                if (probe.onDurable) this.transaction.addEventListener('complete', () => probe.onDurable?.(performance.now()), { once: true });
            }
            return put.call(this, value, ...args);
        };
        probe.observer = new PerformanceObserver(entries => {
            probe.longTasks.push(...entries.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
        });
        probe.observer.observe({ type: 'longtask', buffered: true });
        let previous;
        const frame = now => {
            if (previous !== undefined && probe.active) probe.gaps.push(now - previous);
            previous = now;
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
}

async function environment(browser, variant, source) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundles[variant] });
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline architecture benchmark</title><h1>Storage-only benchmark</h1><script>window.labBootStarted=performance.now()</script><script src="/bundle.js"></script><script>const s=window.architectureLab.store;const done=()=>{window.labHydrationMs=performance.now()-window.labBootStarted;window.labNavigationHydrationMs=performance.now()};if(s.persist.hasHydrated())done();else s.persist.onFinishHydration(done)</script>' });
        return route.abort();
    });
    const newPage = async () => {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/');
        await bootstrap(page);
        return page;
    };
    const page = await newPage();
    if (source) await page.evaluate(async source => {
        window.architectureLab.store.getState().replaceProjects(source);
        await window.architectureLab.flush();
        if (!window.labEqual(await window.architectureLab.read(), source)) throw new Error('Initial fixture round-trip mismatch');
    }, source);
    return { context, page, newPage, errors };
}

async function measure(page, operation, serial) {
    await page.bringToFront();
    return page.evaluate(async ({ operation, serial }) => {
        const lab = window.architectureLab, probe = window.labProbe;
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        // Sample real foreground frame gaps including all stalls, not only <750ms.
        await frame(); await frame();
        probe.puts = []; probe.gaps = []; probe.longTasks = []; probe.active = true;
        const started = performance.now();
        let durableResolve;
        const durable = new Promise(resolve => { durableResolve = resolve; });
        probe.onDurable = durableResolve;
        const project = lab.store.getState().projects.find(project => project.id === 'project-0');
        if (operation === 'node-content' || operation === 'autosave-node') {
            const nodes = project.nodes.slice();
            nodes[1] = { ...nodes[1], metadata: { ...nodes[1].metadata, content: `Measured edit ${serial}: ${nodes[1].metadata.content.split('\n').at(-1)}`.slice(0, 900) } };
            lab.store.getState().updateProject(project.id, { nodes });
        } else {
            lab.store.getState().updateProject(project.id, { viewport: { x: 80 + serial, y: 80 - serial, k: 1 + (serial % 7) / 100 } });
        }
        const actionMs = performance.now() - started;
        let durableEnded;
        if (operation === 'autosave-node') {
            let timeout;
            try { durableEnded = await Promise.race([durable, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Autosave did not durably complete')), 10000); })]); }
            finally { clearTimeout(timeout); }
        } else { await lab.flush(); durableEnded = performance.now(); }
        probe.onDurable = null;
        await frame(); await frame();
        await new Promise(resolve => setTimeout(resolve, 30));
        probe.active = false;
        const sampleEnded = performance.now();
        probe.longTasks.push(...probe.observer.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
        const sorted = [...probe.gaps].sort((a, b) => a - b);
        const rawGaps = [...probe.gaps];
        // Byte encoding, reads and correctness checks occur OUTSIDE the timed region.
        const encoder = new TextEncoder();
        const puts = probe.puts.map(({ store, key, value }) => ({ store, key, jsonStringBytes: typeof value === 'string' ? encoder.encode(value).length : 0, structuredValue: typeof value !== 'string' }));
        const stored = await lab.read();
        if (!window.labEqual(stored, lab.store.getState().projects)) throw new Error('Durable content differs from live store after ' + operation);
        return {
            operation, actionMs, durableMs: durableEnded - started, observationMs: sampleEnded - started,
            puts, jsonStringWriteBytes: puts.reduce((sum, put) => sum + put.jsonStringBytes, 0),
            rawFrameGapsMs: rawGaps, p95FrameGapMs: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null,
            maxFrameGapMs: sorted.at(-1) ?? null, gapsOver50Ms: rawGaps.filter(gap => gap > 50).length, gapsAtLeast750Ms: rawGaps.filter(gap => gap >= 750).length,
            longTasks: probe.longTasks.filter(entry => entry.startTime < sampleEnded && entry.startTime + entry.duration > started),
            strictRoundTrip: true,
        };
    }, { operation, serial });
}

async function quality(browser, variant) {
    const source = fixtures(2, 40);
    const env = await environment(browser, variant, source);
    const checks = ['full fixture strict round-trip'];
    try {
        const a = env.page, b = await env.newPage();
        await Promise.all([[a, 1, 111], [b, 2, 222]].map(([page, index, x]) => page.evaluate(async ({ index, x }) => {
            const lab = window.architectureLab, project = lab.store.getState().projects[0];
            lab.store.getState().updateProject(project.id, { nodes: project.nodes.map((node, i) => i === index ? { ...node, position: { ...node.position, x } } : node) });
            await lab.flush();
        }, { index, x })));
        let stored = await a.evaluate(() => window.architectureLab.read());
        assert.equal(stored[0].nodes[1].position.x, 111);
        assert.equal(stored[0].nodes[2].position.x, 222);
        assert.equal(stored.length, 2);
        assert.deepEqual(stored[0].connections, source[0].connections);
        assert.deepEqual(stored[0].chatSessions, source[0].chatSessions);
        checks.push('two independently hydrated stores preserve separate edits to same project');
        await a.close(); await b.close();
        const c = await env.newPage(), d = await env.newPage();
        await c.evaluate(async () => { window.architectureLab.store.getState().renameProject('project-0', '窗口 A 方案'); await window.architectureLab.flush(); });
        await d.evaluate(async () => { window.architectureLab.store.getState().renameProject('project-0', '窗口 B 方案'); await window.architectureLab.flush(); });
        stored = await d.evaluate(() => window.architectureLab.read());
        const copy = stored.find(project => project.persistenceConflict?.projectId === 'project-0');
        assert(copy, 'Conflict recovery copy missing');
        assert(copy.title.includes('窗口 A 方案'));
        assert.deepEqual(copy.nodes, stored.find(project => project.id === 'project-0').nodes);
        assert.equal(stored.find(project => project.id === 'project-0').title, '窗口 B 方案');
        assert.equal(stored.length, 3);
        checks.push('same-field conflict preserves complete recoverable previous graph');
        await c.close(); await d.close();
        const q = await env.newPage();
        const quota = await q.evaluate(async variant => {
            const lab = window.architectureLab;
            const before = await lab.read();
            // Candidate must roll back a transaction even after an earlier put
            // was already enqueued. Baseline persists the batch in one put.
            window.labProbe.failAfterPuts = variant === 'candidate' ? 1 : 0;
            lab.store.getState().renameProject('project-0', 'Injected failed write');
            lab.store.getState().renameProject('project-1', 'Another change in failed batch');
            let rejected = false;
            try { await lab.flush(); } catch { rejected = true; }
            const unchanged = window.labEqual(before, await lab.read());
            lab.store.getState().renameProject('project-0', 'Retry newest content');
            await lab.flush();
            const after = await lab.read();
            return { rejected, unchanged, retried: after.find(project => project.id === 'project-0').title === 'Retry newest content', expected: lab.store.getState().projects, after };
        }, variant);
        assert(quota.rejected, 'Quota fault did not reject explicit flush');
        assert(quota.unchanged, 'Aborted transaction changed durable data');
        assert(quota.retried, 'Retry did not save newest content');
        assert.deepEqual(quota.after, quota.expected);
        checks.push('QuotaExceededError rolls back whole multi-project batch; retry retains newest edit');
        await q.reload(); await bootstrap(q);
        const reloaded = await q.evaluate(() => window.architectureLab.store.getState().projects);
        assert.deepEqual(reloaded, quota.after);
        const imageHashes = reloaded.flatMap(project => project.nodes.filter(node => node.type === 'image').map(node => hash(node.metadata.content)));
        assert(imageHashes.every(value => value === hash(image)));
        checks.push('fresh-page hydration preserves every field and exact source image bytes');
        await q.evaluate(async () => { window.architectureLab.store.getState().deleteProjects(['project-1']); await window.architectureLab.flush(); });
        assert(!(await q.evaluate(() => window.architectureLab.read())).some(project => project.id === 'project-1'));
        await q.reload(); await bootstrap(q);
        assert(!(await q.evaluate(() => window.architectureLab.store.getState().projects)).some(project => project.id === 'project-1'));
        checks.push('project deletion is durable and cannot resurrect after reload');
        if (variant === 'candidate') assert(await q.evaluate(() => new Promise((resolve, reject) => {
            const opening = indexedDB.open('wireless-canvas');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result, tx = db.transaction('app_state', 'readonly');
                const request = tx.objectStore('app_state').get(JSON.stringify(['wireless-canvas:canvas_store:project-documents:v1', 'project-1']));
                tx.oncomplete = () => { db.close(); resolve(request.result === undefined); };
            };
        })), 'Deleted project document key remains orphaned');
        await q.evaluate(async () => { await window.architectureLab.store.persist.clearStorage(); await window.architectureLab.flush(); });
        assert.deepEqual(await q.evaluate(() => window.architectureLab.read()), []);
        const remainingCanvasKeys = await q.evaluate(() => new Promise((resolve, reject) => {
            const opening = indexedDB.open('wireless-canvas');
            opening.onerror = () => reject(opening.error);
            opening.onsuccess = () => {
                const db = opening.result, tx = db.transaction('app_state', 'readonly'), request = tx.objectStore('app_state').getAllKeys();
                tx.oncomplete = () => { db.close(); resolve(request.result.filter(key => typeof key === 'string' && key.includes('wireless-canvas:canvas_store'))); };
            };
        }));
        assert.deepEqual(remainingCanvasKeys, [], 'clearStorage leaves orphaned canvas document/manifest keys');
        await q.reload(); await bootstrap(q);
        assert.deepEqual(await q.evaluate(() => window.architectureLab.store.getState().projects), []);
        checks.push('clearStorage removes persisted projects and reloads empty');
        assert.deepEqual(env.errors, []);
        return { variant, passed: true, checks, imageSha256: hash(image), pageErrors: env.errors };
    } finally { await env.context.close(); }
}

async function corruptStorageQuality(browser) {
    const checks = [];
    for (const fault of ['missing-document', 'bad-manifest']) {
        const env = await environment(browser, 'candidate', fixtures(2, 40));
        try {
            const outcome = await env.page.evaluate(async fault => {
                const manifest = 'wireless-canvas:canvas_store:project-documents:v1';
                const transaction = (mode, callback) => new Promise((resolve, reject) => {
                    const open = indexedDB.open('wireless-canvas');
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                        const db = open.result, tx = db.transaction('app_state', mode), store = tx.objectStore('app_state');
                        let result;
                        tx.oncomplete = () => { db.close(); resolve(result); };
                        tx.onabort = () => { db.close(); reject(tx.error); };
                        callback(store, value => { result = value; });
                    };
                });
                const raw = () => transaction('readonly', (store, result) => {
                    const keys = store.getAllKeys(), values = store.getAll();
                    values.onsuccess = () => result(keys.result.map((key, i) => [key, values.result[i]]));
                });
                await transaction('readwrite', store => {
                    if (fault === 'missing-document') store.delete(JSON.stringify([manifest, 'project-0']));
                    else store.put({ invalid: 'manifest must be array of unique IDs' }, manifest);
                });
                const before = await raw();
                let readRejected = false, writeRejected = false;
                try { await window.architectureLab.read(); } catch { readRejected = true; }
                window.architectureLab.store.getState().renameProject('project-0', 'Must not overwrite damaged storage');
                try { await window.architectureLab.flush(); } catch { writeRejected = true; }
                return { readRejected, writeRejected, rawUnchanged: window.labEqual(before, await raw()) };
            }, fault);
            assert.deepEqual(outcome, { readRejected: true, writeRejected: true, rawUnchanged: true });
            checks.push(`${fault}: read/write reject; existing raw keys and bytes untouched`);
            assert.deepEqual(env.errors, []);
        } finally { await env.context.close(); }
    }
    return { variant: 'candidate-storage-boundaries', passed: true, checks };
}

function summarize(samples) {
    const median = values => { const sorted = [...values].sort((a, b) => a - b), n = sorted.length; return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2; };
    const result = [];
    for (const [projects, nodes] of fixtureSizes) for (const operation of ['node-content', 'viewport', 'autosave-node']) {
        const group = { projects, nodesPerProject: nodes, operation };
        for (const variant of ['baseline', 'candidate']) {
            const values = samples.filter(sample => sample.projects === projects && sample.nodesPerProject === nodes && sample.variant === variant && sample.operation === operation);
            if (!values.length) continue;
            const ms = values.map(value => value.durableMs);
            group[variant] = { count: values.length, medianDurableMs: median(ms), minDurableMs: Math.min(...ms), maxDurableMs: Math.max(...ms), medianActionMs: median(values.map(value => value.actionMs)), medianJsonWriteBytes: median(values.map(value => value.jsonStringWriteBytes)), worstRawFrameGapMs: Math.max(...values.flatMap(value => value.rawFrameGapsMs)), longTaskCount: values.reduce((sum, value) => sum + value.longTasks.length, 0) };
        }
        if (group.baseline && group.candidate) group.durableImprovementPercent = (1 - group.candidate.medianDurableMs / group.baseline.medianDurableMs) * 100;
        if (group.baseline || group.candidate) result.push(group);
    }
    return result;
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] });
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(), chrome: browser.version(), platform: process.platform, node: process.version, cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem(), mode: qualityOnly ? 'quality-only' : quick ? 'quick' : 'full', viewport: { width: 1440, height: 1000, dpr: 1 }, trialOrder: order, bundles: Object.fromEntries(Object.entries(bundles).map(([name, code]) => [name, { sha256: hash(code), bytes: Buffer.byteLength(code) }])), fixtures: [], quality: [], samples: [], hydration: [], limitations: ['Storage-only production-bundled store harness, not full React UI or GPU rendering.', 'Node-content and viewport samples use explicit flush; autosave-node samples include unchanged 400ms debounce and wait for IndexedDB transaction.complete without forcing flush.', 'Headless Chrome frame cadence is environmental; raw gaps are reported without stall filtering.', 'Image data URLs and metadata retained byte-for-byte; this does not measure image decoding, exports or provider quality.', 'Only JSON string put bytes counted; structured values are identified, not estimated inside timing.', 'Hydration uses fresh document/store reload with warm OS/browser disk cache, not cold-machine startup.'] };
    const resultFile = path.join(output, qualityOnly ? 'browser-quality.json' : quick ? 'browser-quick.json' : 'browser-results.json');
    const save = () => fs.writeFileSync(resultFile, JSON.stringify({ ...report, summary: summarize(report.samples) }, null, 2));
    try {
        for (const variant of ['baseline', 'candidate']) {
            report.quality.push(await quality(browser, variant));
            console.log(`${variant}: browser quality PASS`); save();
        }
        report.quality.push(await corruptStorageQuality(browser)); save();
        console.log('candidate: damaged storage guards PASS');
        if (!qualityOnly) for (const [projects, nodesPerProject] of fixtureSizes) {
            const source = fixtures(projects, nodesPerProject);
            report.fixtures.push({ projects, nodesPerProject, sha256: hash(source), utf8Bytes: Buffer.byteLength(JSON.stringify(source)) });
            const environments = {};
            try {
                for (const variant of ['baseline', 'candidate']) {
                    environments[variant] = await environment(browser, variant, source);
                    await measure(environments[variant].page, 'node-content', 1);
                    await measure(environments[variant].page, 'viewport', 1);
                }
                const trials = { baseline: 0, candidate: 0 };
                for (const variant of order) {
                    const trial = ++trials[variant];
                    for (const operation of ['node-content', 'viewport']) report.samples.push({ variant, projects, nodesPerProject, trial, ...await measure(environments[variant].page, operation, trial + 10) });
                    if (nodesPerProject === 2000 && (projects === 1 || projects === 30)) report.samples.push({ variant, projects, nodesPerProject, trial, ...await measure(environments[variant].page, 'autosave-node', trial + 30) });
                }
                for (let trial = 1; trial <= 3; trial++) for (const variant of (trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])) {
                    const page = environments[variant].page;
                    await page.bringToFront(); await page.reload(); await bootstrap(page);
                    const hydration = await page.evaluate(async () => {
                        if (!window.labEqual(await window.architectureLab.read(), window.architectureLab.store.getState().projects)) throw new Error('Reload hydration mismatch');
                        return { bundleStartToHydratedMs: window.labHydrationMs, navigationToHydratedMs: window.labNavigationHydrationMs };
                    });
                    report.hydration.push({ variant, projects, nodesPerProject, trial, ...hydration });
                }
                for (const env of Object.values(environments)) assert.deepEqual(env.errors, []);
                console.log(`${projects} projects x ${nodesPerProject} nodes: ${order.length * (nodesPerProject === 2000 && (projects === 1 || projects === 30) ? 3 : 2)} samples PASS`); save();
            } finally { for (const env of Object.values(environments)) await env.context.close(); }
        }
        report.completedAt = new Date().toISOString(); report.passed = true; save();
        console.log(JSON.stringify({ passed: true, resultFile, qualityChecks: report.quality.reduce((sum, entry) => sum + entry.checks.length, 0), samples: report.samples.length, summary: summarize(report.samples) }, null, 2));
    } catch (error) { report.passed = false; report.error = error.stack; save(); throw error; }
    finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
