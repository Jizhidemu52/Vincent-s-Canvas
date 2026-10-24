import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";
export default defineConfig(environment => mergeConfig(appConfig(environment), { cacheDir: resolve(import.meta.dirname, "../../output/prompt-favorites-e2e/vite-cache") }));
