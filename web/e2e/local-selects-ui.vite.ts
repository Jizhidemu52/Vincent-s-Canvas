import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";
export default defineConfig(environment => mergeConfig(base(environment), { cacheDir: resolve(import.meta.dirname, "../../output/ui-plan-20261112/local/vite-cache") }));
