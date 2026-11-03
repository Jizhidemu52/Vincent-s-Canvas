import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "./vite.config";

export default defineConfig((environment) =>
    mergeConfig(appConfig(environment), {
        cacheDir: resolve(import.meta.dirname, "../../output/image-agent-validation/streaming-dom-acceptance/vite-cache"),
        // Only the test-owned HTTP SSE server receives continued chat requests.
        server: { proxy: { "/api": { target: "http://127.0.0.1:59887", changeOrigin: false } } },
    }),
);
