import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    // A running developer server may use node_modules/.vite. Do not share its
    // optimizer cache or invalidate that server while executing browser tests.
    cacheDir: resolve(import.meta.dirname, "../../output/phase1-e2e/vite-cache"),
}));
