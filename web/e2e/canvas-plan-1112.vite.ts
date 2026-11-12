import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/ui-plan-20261112/canvas-vite-cache"),
    optimizeDeps: { include: ["file-saver", "fflate"] },
    server: { fs: { allow: [resolve(import.meta.dirname, "../.."), realpathSync(resolve(import.meta.dirname, "../node_modules"))] } },
}));
