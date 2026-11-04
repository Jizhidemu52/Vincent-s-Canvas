import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ResolveModulePreloadDependenciesFn } from "vite";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, webDir, "");
    const canvasStaticImports = new Map<string, Set<string>>();
    const canvasPreload: Plugin = {
        name: "canvas-static-preload",
        enforce: "pre",
        generateBundle(_options, bundle) {
            canvasStaticImports.clear();
            for (const chunk of Object.values(bundle)) {
                if (chunk.type === "chunk" && Object.keys(chunk.modules).some((id) => id.replaceAll("\\", "/").endsWith("/src/pages/canvas/project.tsx"))) {
                    canvasStaticImports.set(chunk.fileName, new Set(chunk.imports.filter((name) => /\.m?js$/.test(name))));
                }
            }
        },
    };
    const resolveCanvasPreloads: ResolveModulePreloadDependenciesFn = (url, deps, { hostId, hostType }) => {
        const alreadyLoaded = hostType === "js" ? canvasStaticImports.get(hostId) : undefined;
        // Static JS has already loaded before this host can call import(). Keep
        // every dynamic target and CSS dependency; unknown hosts stay unchanged.
        return alreadyLoaded ? deps.filter((dep) => dep === url || dep.endsWith(".css") || !alreadyLoaded.has(dep)) : deps;
    };
    return {
        plugins: [react(), canvasPreload, {
            name: "deployment-edition-manifest",
            generateBundle() {
                this.emitFile({ type: "asset", fileName: "deployment-edition.json", source: JSON.stringify({
                    standalone: (process.env.VITE_STANDALONE_EDITION ?? env.VITE_STANDALONE_EDITION) === "true",
                }) });
            },
        }],
        // The image Worker lazily imports PDF support. Keep it an ES module so
        // Vite can emit that optional dependency as a separate worker chunk.
        worker: { format: "es" },
        build: {
            // build.mjs points Vite at a fresh sibling directory, then publishes
            // only after type checking and the bundle budget succeed.
            emptyOutDir: true,
            chunkSizeWarningLimit: 800,
            modulePreload: { resolveDependencies: resolveCanvasPreloads },
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
