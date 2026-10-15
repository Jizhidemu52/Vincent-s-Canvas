import type { Plugin } from 'vite';

// This is a disclosed local host adapter, not an upstream backend implementation.
// Runtime source transforms below are Chinese presentation-only changes; no
// canvas, document, history, lock, or serialization logic is replaced.
export default function offlineHostAdapter(): Plugin {
  return {
    name: 'local-chinese-offline-boundary',
    enforce: 'pre',
    transformIndexHtml(html) {
      return html.replace(/<title>[\s\S]*?<\/title>/, '<title>图案编辑实验｜离线验证</title>');
    },
    transform(source, id) {
      const file = id.replaceAll('\\', '/').split('?')[0];
      if (file.endsWith('/src/language/index.ts')) return source.replace('const lang = getLocalLang();', "const lang = 'zh'; // 本地实测固定中文");
      if (file.endsWith('/src/components/lang.vue')) return source.replace("  en: 'En',", '');
      if (file.endsWith('/src/components/logo.vue')) return source.replace('alt="webInfo.name"', 'alt="图案编辑实验"');
      if (file.endsWith('/src/views/home/components/top/index.vue')) return source.replace('alt="vue-fbric-editor"', 'alt="商业版链接（离线未开放）"');
      if (file.endsWith('/src/components/importTmpl.vue')) return source.replace('<Divider plain v-if="isDownBottm">已经到底了</Divider>', '<p v-if="isDownBottm" style="padding:18px 8px;color:#657365;line-height:1.8;white-space:normal">离线模板库未连接。请通过顶部“插入”使用本地素材。</p>');
      if (file.endsWith('/src/components/common/typeList.vue')) return source.replace('<div class="material-type">', '<div class="material-type"><p v-if="materialTypeList.length === 0" style="padding:20px 8px;color:#657365;line-height:1.8">离线素材库未连接，可通过顶部“插入”添加自己的素材。</p>');
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1:4330');
        if (!url.pathname.startsWith('/offline-api/')) return next();
        response.setHeader('X-Local-Adapter', 'offline-fixture-not-upstream');
        response.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/offline-api/logo.svg') {
          response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
          response.end('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="36" viewBox="0 0 120 36"><rect width="120" height="36" rx="4" fill="#edf2e8"/><text x="60" y="23" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="15" font-weight="700" fill="#4e6850">图案编辑实验</text></svg>');
          return;
        }
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: { message: '离线实测不支持登录、上传或云端写入。请使用本地 JSON / PNG 下载。' }, offline: true }));
          return;
        }
        if (url.pathname === '/offline-api/api/users/me') {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: { message: '当前为离线访客，未连接账号服务。' }, offline: true }));
          return;
        }
        if (url.pathname === '/offline-api/api/web-site') {
          response.end(JSON.stringify({ data: { attributes: { name: '图案编辑实验', url: '/', logo: { data: { attributes: { url: '/logo.svg' } } } } }, meta: { offline: true, localAdapter: '本地离线站点信息，未连接账号服务' } }));
          return;
        }
        response.end(JSON.stringify({ data: [], meta: { pagination: { page: 1, pageCount: 1, pageSize: 10, total: 0 }, offline: true, localAdapter: '本地空素材适配，原在线素材库未连接' } }));
      });
    },
  };
}
