import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

export default defineConfig(environment => mergeConfig(appConfig(environment), {
    // Keep this optimizer isolated while retaining node_modules exclusion from
    // React's Babel transform; otherwise the whole prebundled antd is recompiled.
    cacheDir: resolve(import.meta.dirname, "../../output/admin-usage-optimization/node_modules/.vite"),
    resolve: { dedupe: ["react", "react-dom"], alias: { zod: resolve(import.meta.dirname, "../../server/node_modules/zod") } },
    optimizeDeps: { include: ["react", "react-dom/client", "react-router-dom", "antd", "@ant-design/icons", "@tanstack/react-query", "lucide-react", "zustand", "file-saver"] },
}));
