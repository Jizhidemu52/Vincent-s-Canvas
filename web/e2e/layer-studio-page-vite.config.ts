import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import fixtureConfig from "./vite.config";

export default defineConfig(environment => mergeConfig(fixtureConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/seedream55-integration/page-vite-cache"),
}));
