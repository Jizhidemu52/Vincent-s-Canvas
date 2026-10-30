import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";
export default defineConfig(environment => mergeConfig(appConfig(environment), {
    cacheDir: resolve(import.meta.dirname, "../../output/interaction-experience/shell/vite-cache"),
    resolve: { dedupe: ["react", "react-dom"], alias: { zod: resolve(import.meta.dirname, "../../server/node_modules/zod") } },
    optimizeDeps: { include: ["react", "react-dom/client", "react-router-dom", "antd", "@ant-design/icons", "@tanstack/react-query", "lucide-react", "zustand", "file-saver", "react-router"] },
}));
