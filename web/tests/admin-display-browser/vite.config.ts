import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import fixtureConfig from "../../e2e/vite.config";
export default defineConfig(environment => mergeConfig(fixtureConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../../output/i18n-complete-20261113/admin-display-vite-cache"),
    server: { host: "127.0.0.1", port: 5227, strictPort: true },
    optimizeDeps: { include: ["file-saver", "echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"] },
}));
