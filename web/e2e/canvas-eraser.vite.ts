import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "./generation-ux.vite";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/canvas-eraser/vite-cache"),
}));
