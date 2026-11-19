import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

export default defineConfig(environment => mergeConfig(baseConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/result-notification-recovery/vite-cache"),
}));
