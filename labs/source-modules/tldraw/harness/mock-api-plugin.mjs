import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const evidenceDir = fileURLToPath(new URL('../evidence/', import.meta.url));
const escapeXml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function mockApiPlugin() {
  let requests = [], plans = [], sequence = 0;
  const images = new Map();
  return {
    name: 'explicit-local-model-boundary-stub',
    transformIndexHtml() {
      return [
        { tag: 'div', attrs: { id: 'original-source-lab-notice', style: 'position:fixed;left:12px;bottom:8px;z-index:99999;padding:6px 10px;background:#fff4cc;color:#372e14;border:1px solid #d7bf62;border-radius:5px;font:11px system-ui;pointer-events:none' }, children: '上游原始模板 · 本地模型接口模拟 · 不调用 AI / 不产生费用', injectTo: 'body' },
        { tag: 'script', attrs: { type: 'module', src: '/@fs/' + fileURLToPath(new URL('./lab-panel.js', import.meta.url)).replaceAll('\\','/') }, injectTo: 'body' },
      ];
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = req.url?.split('?')[0] || '';
        if (!pathname.startsWith('/api/') && !pathname.startsWith('/__lab/')) return next();
        const send = (value, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
        try {
          if (pathname.startsWith('/__lab/assets/')) {
            const assetRoot = fileURLToPath(new URL('../node_modules/@tldraw/assets/', import.meta.url));
            const relative = decodeURIComponent(pathname.slice('/__lab/assets/'.length));
            const asset = path.resolve(assetRoot, relative);
            if (!asset.startsWith(assetRoot) || relative.includes('..')) return send({ error: '不支持的资源路径' }, 400);
            let content = await readFile(asset);
            const ext = path.extname(asset);
            if (relative === 'translations/zh-cn.json') {
              const zh = JSON.parse(content.toString('utf8'));
              zh['shortcuts-dialog.disabled-notice'] = '当前已禁用键盘快捷键。';
              zh['comments.link-copied'] = '链接已复制';
              content = Buffer.from(JSON.stringify(zh));
            }
            res.setHeader('Content-Type', ({ '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2' })[ext] || 'application/octet-stream');
            res.end(content); return;
          }
          if (pathname.startsWith('/__lab/image/')) {
            const id = pathname.split('/').pop().replace(/\.svg$/, '');
            const svg = images.get(id); if (!svg) return send({ error: 'Unknown local fixture' }, 404);
            res.setHeader('Content-Type', 'image/svg+xml'); res.end(svg); return;
          }
          if (pathname === '/__lab/state') return send({ requests, pendingPlans: plans.length, networkPolicy: 'model requests terminate locally; no provider API is contacted' });
          if (pathname === '/__lab/results') {
            const content = await readFile(new URL('../evidence/results.json', import.meta.url), 'utf8').catch(() => '{}');
            res.setHeader('Content-Type', 'application/json'); res.end(content); return;
          }
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 10_000_000) return send({ error: 'Lab body too large' }, 413); chunks.push(chunk); }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (pathname === '/__lab/control') {
            requests = []; plans = Array.isArray(body.plans) ? body.plans : [];
            return send({ ok: true, mode: 'local model boundary stub', plans: plans.length });
          }
          if (!pathname.startsWith('/api/')) return send({ error: 'Unknown lab endpoint' }, 404);
          const id = String(++sequence);
          const planIndex = plans.findIndex(plan => !plan.matchPrompt || String(body.prompt || '').includes(plan.matchPrompt));
          const plan = planIndex >= 0 ? plans.splice(planIndex, 1)[0] : {};
          const entry = { id, pathname, startedAt: Date.now(), body, scenario: plan, finishedAt: null };
          requests.push(entry);
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(new URL('../evidence/mock-api-latest.json', import.meta.url), JSON.stringify(requests, null, 2));
          if (plan.delayMs) await new Promise(resolve => setTimeout(resolve, Math.min(plan.delayMs, 5000)));
          entry.finishedAt = Date.now();
          if (plan.status && plan.status !== 200) { entry.status = plan.status; return send({ error: plan.error || 'INTENTIONAL_LOCAL_FAILURE' }, plan.status); }
          entry.status = 200;
          const label = String(body.prompt || pathname).slice(0, 95);
          images.set(id, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420"><rect width="640" height="420" fill="#eef2e8"/><path d="M90 180 Q170 40 300 180 T550 180V350H90Z" fill="#b4c6a8"/><rect x="28" y="26" width="290" height="32" rx="6" fill="#273e2c"/><text x="42" y="48" fill="white" font-size="16" font-family="sans-serif">本地接口模拟图片 · 未调用 AI 模型</text><text x="30" y="385" fill="#253a29" font-size="14" font-family="sans-serif">${escapeXml(label)}</text></svg>`);
          return send(pathname === '/api/generate-text' ? { text: `本地模拟文本：${label}` } : { imageUrl: `/__lab/image/${id}.svg`, seed: body.seed ?? 1 });
        } catch (error) { return send({ error: String(error) }, 500); }
      });
    },
  };
}
