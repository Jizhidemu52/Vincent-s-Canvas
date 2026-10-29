import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.env.CANVAS_PERF_DIST || "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname.startsWith("/api/")) { response.writeHead(501); response.end("All APIs must be intercepted by MockCanvasApi"); return; }
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    try {
        const target = extname(path) ? path : resolve(root, "index.html");
        response.writeHead(200, { "Content-Type": types[extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
        response.end(await readFile(target));
    } catch { response.writeHead(404); response.end(); }
}).listen(Number(process.env.CANVAS_PERF_PORT || 5201), "127.0.0.1");
