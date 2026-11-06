import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
    cacheDir: resolve(import.meta.dirname, "../../output/agent-document-parser/vite-cache"),
    optimizeDeps: { entries: ["e2e/agent-document-parser.fixture.html"], include: ["mammoth", "xlsx"] },
    server: { fs: { allow: [resolve(import.meta.dirname, "../.."), realpathSync(resolve(import.meta.dirname, "../node_modules"))] } },
});
