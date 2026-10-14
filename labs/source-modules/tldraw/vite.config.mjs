import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { mockApiPlugin } from './harness/mock-api-plugin.mjs';
import { chineseUiPlugin } from './harness/chinese-ui-plugin.mjs';

export default defineConfig({
  root: fileURLToPath(new URL('./upstream/templates/image-pipeline', import.meta.url)),
  plugins: [chineseUiPlugin(), react(), mockApiPlugin()],
  cacheDir: fileURLToPath(new URL('./.vite-cache', import.meta.url)),
  server: {
    host: '127.0.0.1', port: 4332, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
});
