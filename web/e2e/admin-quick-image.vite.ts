import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), { cacheDir: resolve(import.meta.dirname, "../../output/paid-regression-20261106/admin-quick-image-vite-cache") }));
