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
        plugins: [react(), {
            name: "deployment-edition-manifest",
            generateBundle() {
                this.emitFile({ type: "asset", fileName: "deployment-edition.json", source: JSON.stringify({
                    standalone: (process.env.VITE_STANDALONE_EDITION ?? env.VITE_STANDALONE_EDITION) === "true",
                }) });
            },
        }],
        build: {
            // A deploy is a complete immutable asset set. Keeping old hashed files
            // here made local packages grow by hundreds of megabytes after rebuilds.
            emptyOutDir: true,
            chunkSizeWarningLimit: 800,
            rollupOptions: {
                output: {
                    onlyExplicitManualChunks: true,
                    manualChunks(id) {
                        const path = id.replaceAll("\\", "/");
                        if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return "vendor-react";
                        if (/\/node_modules\/(antd|@ant-design\/[^/]+|@rc-component\/[^/]+|rc-[^/]+)\//.test(path)) return "vendor-antd";
                        // Keep the small strict-JSON parser usable without loading the editor.
                        if (/\/node_modules\/(@codemirror\/[^/]+|@uiw\/react-codemirror)\//.test(path)) return "vendor-codemirror";
                    },
                },
            },
        },
        server: {
            proxy: {
                // Preserve the browser-facing Host so the API's same-origin write guard can verify Origin.
                "/api": { target: process.env.VITE_API_PROXY_TARGET || env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3100", changeOrigin: false },
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
