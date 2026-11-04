import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    // A running developer server may use node_modules/.vite. Do not share its
    // optimizer cache or invalidate that server while executing browser tests.
    cacheDir: resolve(import.meta.dirname, "../../output/phase1-e2e/vite-cache"),
    // The fixture blocks WebSockets, including Vite's reload notification.
    // Discover export dependencies before a lazy menu can mix React cache hashes.
    optimizeDeps: { include: ["file-saver", "fflate"] },
    // Include shared sources and dependencies reused through the worktree junction.
    server: { fs: { allow: [resolve(import.meta.dirname, "../.."), realpathSync(resolve(import.meta.dirname, "../node_modules"))] } },
}));
