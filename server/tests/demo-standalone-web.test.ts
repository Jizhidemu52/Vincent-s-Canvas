import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { resolveStandaloneStaticPath, serveStandaloneWeb } from "../src/demo-standalone-web";

let webRoot: string;
const script = 'console.log("静态资源");\n'.repeat(200);
const html = `<!doctype html><html><body>${"页面内容".repeat(300)}</body></html>`;
beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "canvas-static-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "assets/app-aBc_1234.js"), script);
  await writeFile(join(webRoot, "assets/plain.js"), script);
  await writeFile(join(webRoot, "index.html"), html);
});
afterAll(async () => {
  if (webRoot && resolve(webRoot).startsWith(join(tmpdir(), "canvas-static-"))) await rm(webRoot, { recursive: true, force: true });
});
const request = (path: string, encoding?: string, method = "GET") => new Request(`http://127.0.0.1${path}`, {
  method, ...(encoding ? { headers: { "accept-encoding": encoding } } : {}),
});

test("serves standalone files from the build directory without allowing path traversal", () => {
  const root = resolve("portable", "web");
  expect(resolveStandaloneStaticPath(root, "/")).toBe(join(root, "index.html"));
  expect(resolveStandaloneStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
  expect(resolveStandaloneStaticPath(root, "/../.env")).toBeNull();
});

test("compresses fingerprinted text assets and keeps safe cache and type headers", async () => {
  const response = await serveStandaloneWeb(request("/assets/app-aBc_1234.js", "gzip"), webRoot);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-encoding")).toBe("gzip");
  expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(response?.headers.get("vary")).toBe("Accept-Encoding");
  expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response?.headers.get("content-type")).toContain("javascript");
  const encoded = await response!.arrayBuffer();
  expect(encoded.byteLength).toBeLessThan(Buffer.byteLength(script));
  expect(gunzipSync(encoded).toString()).toBe(script);
});

test.each([undefined, "gzip;q=0", "gzip;q=0.1, identity;q=1", "br"])("honors identity preference and q=0: %s", async encoding => {
  const response = await serveStandaloneWeb(request("/assets/app-aBc_1234.js", encoding), webRoot);
  expect(response?.headers.get("content-encoding")).toBeNull();
  expect(response?.headers.get("vary")).toBe("Accept-Encoding");
  expect(await response!.text()).toBe(script);
});

test("rejects a request that forbids every available encoding", async () => {
  const response = await serveStandaloneWeb(request("/assets/app-aBc_1234.js", "gzip;q=0, identity;q=0"), webRoot);
  expect(response?.status).toBe(406);
  expect(response?.headers.get("cache-control")).toBe("no-store");
});

test.each(["/", "/canvas/example", "/assets", "/assets/"])("keeps HTML and SPA fallback uncacheable: %s", async path => {
  const response = await serveStandaloneWeb(request(path, "gzip"), webRoot);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("content-type")).toContain("text/html");
  expect(gunzipSync(await response!.arrayBuffer()).toString()).toBe(html);
});

test("does not give unversioned resources immutable caching or serve missing assets as HTML", async () => {
  const plain = await serveStandaloneWeb(request("/assets/plain.js"), webRoot);
  expect(plain?.headers.get("cache-control")).toBe("no-cache");
  const missing = await serveStandaloneWeb(request("/assets/missing-12345678.js", "gzip"), webRoot);
  expect(missing?.status).toBe(404);
  expect(missing?.headers.get("cache-control")).toBe("no-store");
  expect(missing?.headers.get("content-type")).not.toContain("text/html");
});

test("HEAD uses the negotiated representation headers without a response body", async () => {
  const response = await serveStandaloneWeb(request("/assets/app-aBc_1234.js", "gzip", "HEAD"), webRoot);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-encoding")).toBe("gzip");
  expect(Number(response?.headers.get("content-length"))).toBeGreaterThan(0);
  expect((await response!.arrayBuffer()).byteLength).toBe(0);
});

test("refreshes compressed content when a static file changes on disk", async () => {
  const filePath = join(webRoot, "assets/rebuilt-12345678.js");
  await writeFile(filePath, script);
  const first = await serveStandaloneWeb(request("/assets/rebuilt-12345678.js", "gzip"), webRoot);
  expect(gunzipSync(await first!.arrayBuffer()).toString()).toBe(script);
  const changed = script.replaceAll("静态资源", "更新资源");
  await writeFile(filePath, changed);
  const later = new Date(Date.now() + 2000);
  await utimes(filePath, later, later);
  const second = await serveStandaloneWeb(request("/assets/rebuilt-12345678.js", "gzip"), webRoot);
  expect(gunzipSync(await second!.arrayBuffer()).toString()).toBe(changed);
});

test("does not intercept APIs or writes", async () => {
  expect(await serveStandaloneWeb(request("/api/chat/responses"), webRoot)).toBeNull();
  expect(await serveStandaloneWeb(request("/canvas", undefined, "POST"), webRoot)).toBeNull();
});
