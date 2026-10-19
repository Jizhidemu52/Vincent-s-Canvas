import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import Negotiator from "negotiator";

const compress = promisify(gzip);
const compressibleFile = /\.(?:js|mjs|css|html|json|svg|txt)$/i;
const fingerprintedAsset = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const maxCacheBytes = 32 * 1024 * 1024;
const maxCacheEntries = 64;
const gzipCache = new Map<string, { signature: string; body: Uint8Array }>();
let cacheBytes = 0;
const safetyHeaders = { "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

function forgetCompressed(path: string) {
  const cached = gzipCache.get(path);
  if (cached) cacheBytes -= cached.body.byteLength;
  gzipCache.delete(path);
}

async function staticFile(request: Request, path: string): Promise<Response | null> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!info?.isFile()) return null;
  const file = Bun.file(path);
  const isHtml = extname(path).toLowerCase() === ".html";
  const headers = new Headers({ ...safetyHeaders, "content-type": file.type,
    "cache-control": isHtml ? "no-store" : fingerprintedAsset.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  const compressible = compressibleFile.test(path) && info.size >= 1024 && info.size <= 16 * 1024 * 1024;
  if (compressible) headers.set("vary", "Accept-Encoding");
  const encoding = new Negotiator({ headers: { "accept-encoding": request.headers.get("accept-encoding") ?? undefined } })
    .encoding(compressible ? ["gzip", "identity"] : ["identity"]);
  if (!encoding) return new Response(null, { status: 406, headers: { ...safetyHeaders, "cache-control": "no-store", vary: "Accept-Encoding" } });

  let body: Blob | Uint8Array = file;
  if (encoding === "gzip") {
    const signature = `${info.size}:${info.mtimeMs}`;
    const cached = gzipCache.get(path);
    if (cached?.signature === signature && !isHtml) {
      body = cached.body;
      gzipCache.delete(path);
      gzipCache.set(path, cached);
    } else {
      forgetCompressed(path);
      body = new Uint8Array(await compress(await file.arrayBuffer(), { level: 5 }));
      if (!isHtml && body.byteLength <= maxCacheBytes) {
        while (gzipCache.size >= maxCacheEntries || cacheBytes + body.byteLength > maxCacheBytes) forgetCompressed(gzipCache.keys().next().value!);
        gzipCache.set(path, { signature, body });
        cacheBytes += body.byteLength;
      }
    }
    headers.set("content-encoding", "gzip");
  }
  headers.set("content-length", String(body instanceof Uint8Array ? body.byteLength : info.size));
  return new Response(request.method === "HEAD" ? null : body as BodyInit, { headers });
}

export function resolveStandaloneStaticPath(rootDirectory: string, pathname: string) {
  const root = resolve(rootDirectory);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

/** Static files and SPA fallback share compression and cache policy; APIs do not. */
export async function serveStandaloneWeb(request: Request, rootDirectory: string): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method) || pathname === "/api" || pathname.startsWith("/api/")) return null;
  const path = resolveStandaloneStaticPath(rootDirectory, pathname);
  if (path) {
    const response = await staticFile(request, path);
    if (response) return response;
    if (!extname(pathname) && (pathname === "/assets/" || !pathname.startsWith("/assets/"))) {
      const fallback = await staticFile(request, resolve(rootDirectory, "index.html"));
      if (fallback) return fallback;
    }
  }
  return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers: { ...safetyHeaders, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
}
