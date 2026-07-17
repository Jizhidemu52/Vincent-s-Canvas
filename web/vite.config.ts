import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, webDir, "");
    return {
        plugins: [react()],
        build: {
            chunkSizeWarningLimit: 1500,
        },
        server: {
            proxy: {
                "/api": { target: env.VITE_API_PROXY_TARGET || "http://localhost:3100", changeOrigin: true },
            },
        },
        resolve: {
            alias: {
                "@": resolve(webDir, "src"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(localVersion),
        },
    };
});
