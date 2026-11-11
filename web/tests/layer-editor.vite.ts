import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";
export default defineConfig(environment => mergeConfig(appConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/seedream55-integration/editor-tests/vite-cache"),
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { include: ["react", "react-dom/client", "zustand"] },
}));
