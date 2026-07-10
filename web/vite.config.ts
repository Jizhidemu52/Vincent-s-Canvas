import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { parseChangelog } from "./src/lib/release";
import { internalAiProxyPlugin } from "./internal-ai-proxy";
import { companyAssetDatabaseProxyPlugin } from "./company-asset-database-proxy";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, webDir, "");
    return {
        plugins: [
            react(),
            internalAiProxyPlugin({
                appKey: env.INTERNAL_AI_APP_KEY,
                seamlessUrl: env.INTERNAL_AI_SEAMLESS_URL,
                configPath: resolve(webDir, "../data/internal-ai-config.json"),
                configToken: env.INTERNAL_AI_CONFIG_TOKEN,
                mock: env.INTERNAL_AI_MOCK === "true",
            }),
            companyAssetDatabaseProxyPlugin({
                configPath: resolve(webDir, "../data/company-asset-database-config.json"),
                baseUrl: env.COMPANY_ASSET_DATABASE_URL,
                apiToken: env.COMPANY_ASSET_DATABASE_TOKEN,
                configToken: env.INTERNAL_AI_CONFIG_TOKEN,
            }),
        ],
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
            __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        },
    };
});
