import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../../vite.config";
export default defineConfig((environment) =>
    mergeConfig(appConfig(environment), {
        cacheDir: resolve(import.meta.dirname, "../../../output/usage-mature-results-browser/vite-cache"),
        server: { host: "127.0.0.1", port: 5404, strictPort: true },
        optimizeDeps: {
            include: ["file-saver", "echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
        },
    }),
);
