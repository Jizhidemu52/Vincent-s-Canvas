import { resolve, sep, extname } from 'node:path';

const root = import.meta.dir;
const port = Number(process.env.DESIGN_DEMO_PORT || 4328);
const titles: Record<string, { index: string; title: string; description: string; status: string }> = {
    placement: { index: '01', title: '图案贴合工作台', description: '先把位置、大小和图层关系确定，再讨论人工智能融合。', status: '真实本地编辑 / 导出' },
    repeat: { index: '02', title: '花型循环工作台', description: '从一个循环单元，看到整块面料。', status: '真实几何铺排 / 导出' },
    recipe: { index: '03', title: '系列开发流程', description: '把重复操作保存成配方，试一遍分支、进度和失败续跑。', status: '模拟任务 / 实际费用 ¥0' },
};
const header = (active = '') => `<header class="lab-header"><a class="lab-brand" href="/" aria-label="设计实验室首页"><span class="lab-mark">V</span><span>文森特<small>设计实验室</small></span></a><nav class="lab-nav" aria-label="工作台"><a href="/" ${active === '' ? 'aria-current="page"' : ''}>概览</a>${Object.entries(titles).map(([key, item]) => `<a href="/demo/${key}" ${active === key ? 'aria-current="page"' : ''}>${item.title.replace('工作台', '')}</a>`).join('')}</nav><span class="lab-state"><i class="state-dot"></i>独立试用版 · 未接入正式画布</span></header>`;
const footer = `<footer class="demo-footer"><span>编辑在本机浏览器内完成；请手动保存或导出。没有账号上传，没有模型调用。</span><span>先试用，再决定接入 · <a href="/">返回实验室</a></span></footer>`;
const htmlHead = (title: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="独立服装设计工作台试用版：图案贴合、花型循环和系列开发流程。"><title>${title} · 设计实验室</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/shared.css"></head><body>`;
const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
};
const html = (body: string) => new Response(body, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Local read-only demo host', { status: 405, headers });
    if (url.pathname === '/health') return Response.json({ ok: true, app: 'vincent-design-lab', port, paidCalls: false, productionIntegration: false }, { headers });
    if (url.pathname === '/') return html(htmlHead('设计实验室') + header() + await Bun.file(resolve(root, 'home.html')).text() + footer + '</body></html>');
    const key = url.pathname.match(/^\/demo\/(placement|repeat|recipe)\/?$/)?.[1];
    if (key) {
        const item = titles[key];
        return html(htmlHead(item.title) + header(key) + `<section class="demo-heading"><div class="demo-heading-title"><span class="index">${item.index}</span><div><h1>${item.title}</h1><p>${item.description}</p></div></div><span class="badge">${item.status}</span></section><main id="demo" class="demo-root"><p class="loading">正在打开工作台…</p></main>` + footer + `<script type="module">import {notify} from '/shared.js';try{const {mountDemo}=await import('/${key}/main.js');const root=document.querySelector('#demo');root.replaceChildren();const cleanup=await mountDemo(root);if(typeof cleanup==='function')window.addEventListener('pagehide',cleanup,{once:true});}catch(error){document.querySelector('#demo').textContent='工作台未能打开：'+error.message;notify(error.message,'error');console.error(error);}</script></body></html>`);
    }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400, headers }); }
    if (!/^\/(?:shared\.(?:js|css)|shell-fonts\.css|favicon\.svg|(?:assets|placement|repeat|recipe)\/[a-zA-Z0-9_./-]+\.(?:js|mjs|css|svg|png|webp|jpg|json))$/.test(pathname)) return new Response('Not found', { status: 404, headers });
    const filePath = resolve(root, `.${pathname}`);
    if (!filePath.startsWith(root + sep)) return new Response('Not found', { status: 404, headers });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response('Not found', { status: 404, headers });
    const mime: Record<string, string> = { '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8' };
    return new Response(request.method === 'HEAD' ? null : file, { headers: { ...headers, 'content-type': mime[extname(filePath)] || 'application/octet-stream' } });
} });
console.log(`Vincent Design Lab: ${server.url}`);
console.log('Local only. No model calls. No production project integration.');
