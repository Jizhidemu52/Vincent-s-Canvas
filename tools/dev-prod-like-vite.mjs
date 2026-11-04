import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProdLikeConfig } from "./dev-prod-like.mjs";

export function prodLikeViteOptions(config) {
    const web = resolve(config.root, "web");
    return {
        root: web, configFile: false, envDir: false, clearScreen: false,
        cacheDir: resolve(config.root, "output/prod-like/vite-cache"),
        resolve: { alias: { "@": resolve(web, "src") } },
        define: { __APP_VERSION__: JSON.stringify(readFileSync(resolve(config.root, "VERSION"), "utf8").trim() || "dev") },
        worker: { format: "es" },
        server: {
            host: "127.0.0.1", port: config.ports.WEB, strictPort: true,
            proxy: { "/api": { target: `http://127.0.0.1:${config.ports.API}`, changeOrigin: false } },
            fs: { allow: [config.root, realpathSync(resolve(web, "node_modules"))] },
        },
    };
}

export async function main() {
    const config = createProdLikeConfig();
    const requireWeb = createRequire(resolve(config.root, "web/package.json"));
    const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
    const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
    const server = await createServer({ ...prodLikeViteOptions(config), plugins: [react()] });
    await server.listen();
    server.printUrls();
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
