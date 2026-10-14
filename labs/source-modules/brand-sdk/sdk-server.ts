import path from 'node:path';
const publicDir = path.join(import.meta.dir, 'qa', 'public');
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
const server = Bun.serve({ hostname: '127.0.0.1', port: 4331, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/') return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>原 SDK 模块实测</title><style>body{font-family:system-ui,sans-serif;background:#f4f4ef;color:#24342b;margin:40px}main{max-width:850px;margin:auto}button{padding:9px 14px;margin:4px;cursor:pointer}#plugin-node{width:320px;height:230px;margin:28px 0}pre{padding:18px;background:white;border:1px solid #ddd}.controls{display:flex;gap:6px}h1{font-size:25px}p{line-height:1.7}</style><div id="app"></div><script type="module" src="/host.js"></script></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store' } });
  if (url.pathname === '/host.js') return new Response(Bun.file(path.join(publicDir, 'host.js')), { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
  if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
  return new Response('Not found', { status: 404 });
} });
console.log(String(server.url));
