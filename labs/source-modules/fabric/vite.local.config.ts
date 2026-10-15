import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import { createHtmlPlugin } from 'vite-plugin-html';
import vueSetupExtend from 'vite-plugin-vue-setup-extend-plus';
import autoImports from 'unplugin-auto-import/vite';
import svgLoader from 'vite-svg-loader';
import autoprefixer from 'autoprefixer';
import path from 'node:path';
import offlineHostAdapter from './offline-host-adapter';
const upstream = path.resolve(import.meta.dirname, 'upstream');
const offlinePolicy = "default-src 'self'; connect-src 'self' data: blob: ws://127.0.0.1:4330; script-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; font-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'none'";

// Host-only adapter: original src and packages/core are kept unchanged. The local
// manifest omits lint/commit tooling; this config preserves the runtime compilers.
export default defineConfig(({ mode }) => ({
  root: upstream,
  envDir: upstream,
  envPrefix: 'APP_',
  base: '/',
  define: { 'import.meta.env.APP_APIHOST': JSON.stringify('http://127.0.0.1:4330/offline-api'), 'import.meta.env.APP_ADMINAPIHOST': JSON.stringify('http://127.0.0.1:4330/offline-api') },
  plugins: [
    offlineHostAdapter(),
    vue(),
    autoImports({ imports: ['vue'], dts: false, eslintrc: { enabled: false } }),
    (typeof vueSetupExtend === 'function' ? vueSetupExtend : vueSetupExtend.default)(), vueJsx(),
    createHtmlPlugin({ inject: { data: { title: '图案编辑实验 · 离线验证' } } }),
    svgLoader(),
    { name: 'local-qa-boundary-notice', transformIndexHtml: () => [{ tag: 'div', attrs: { id: 'local-qa-boundary', style: 'position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:1200;padding:5px 12px;border:1px solid #d6dfcf;background:#f3f7ef;color:#506147;border-radius:6px;font:12px sans-serif;pointer-events:none' }, children: '图案编辑实验 · 外网已禁用 · 在线模板/字体不可用', injectTo: 'body' }] },
  ],
  resolve: {
    alias: [
      { find: '@kuaitu/core', replacement: path.join(upstream, 'packages/core/index.ts') },
      { find: /^@\//, replacement: path.join(upstream, 'src') + '/' },
      { find: /^~/, replacement: '' },
      { find: /^vue-i18n$/, replacement: 'vue-i18n/dist/vue-i18n.cjs.js' },
    ],
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.vue', '.json', '.less', '.css'],
    dedupe: ['fabric', 'vue'],
  },
  css: {
    postcss: { plugins: [autoprefixer()] },
    preprocessorOptions: { less: { javascriptEnabled: true, additionalData: `@import '${path.join(upstream, 'src/styles/variable.less').replaceAll('\\', '/')}';` } },
  },
  server: { host: '127.0.0.1', port: 4330, strictPort: true, open: false, headers: { 'Content-Security-Policy': offlinePolicy }, fs: { allow: [path.dirname(upstream)] } },
}));
