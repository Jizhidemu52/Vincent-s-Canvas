import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/image-generation-settings-dialog/vite-cache"),
    resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { entries: ["e2e/image-generation-settings-dialog.fixture.tsx"], include: ["react", "react-dom/client", "antd", "lucide-react", "zustand", "radix-ui"] },
    server: { fs: { allow: [resolve(import.meta.dirname, "../.."), realpathSync(resolve(import.meta.dirname, "../node_modules"))] } },
}));
