import { fileURLToPath } from "node:url";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { parseSrcset } from "srcset";
import { PublicFetchError, validatePublicUrl } from "./public-fetch.mjs";

const MiB = 1024 * 1024;
export class ReferenceImportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "ReferenceImportError"; }
}
export type FetchedReference = { bytes: Buffer; mime: string; finalUrl: string };
export type ReferenceFetcher = (url: string, kind: "html" | "image", signal: AbortSignal) => Promise<FetchedReference>;
export type ReferenceCandidate = { id: string; name: string; sourceImage: string };
export type ReferenceScan = { scanId: string; pageUrl: string; pageTitle: string; candidates: ReferenceCandidate[]; expiresAt: string; warnings: string[] };
export type ReferenceImage = { id: string; name: string; mime: string; base64: string; sourcePage: string; sourceImage: string; pageTitle: string };

function error(status: number, code: string, message: string) { return new ReferenceImportError(status, code, message); }
function checkedUrl(input: string) {
  try { return validatePublicUrl(input); }
  catch (cause) { if (cause instanceof PublicFetchError) throw error(cause.status, cause.code, cause.message); throw cause; }
}
export function sanitizeSourceUrl(input: string): string {
  const url = new URL(input); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href;
}

/** Production fetch always uses native Node. Only a small explicit environment
 * is passed; proxy credentials, NODE_OPTIONS and TLS-disable flags never enter. */
export const fetchReferenceResource: ReferenceFetcher = async (url, kind, signal) => {
  checkedUrl(url);
  signal.throwIfAborted();
  const node = Bun.which("node");
  if (!node) throw error(503, "NATIVE_NODE_REQUIRED", "网页采集需要原生 Node.js 运行环境");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "NODE_EXTRA_CA_CERTS"]) if (process.env[key]) env[key] = process.env[key]!;
  const child = Bun.spawn([node, fileURLToPath(new URL("./fetch-worker.mjs", import.meta.url))], {
    stdin: new Blob([JSON.stringify({ url, kind })]), stdout: "pipe", stderr: "ignore", env,
  });
  const reader = child.stdout.getReader();
  const abort = () => { child.kill(); void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const deadline = setTimeout(abort, 20_000);
  try {
    const parts: Uint8Array[] = [];
    let size = 0;
    const maxOutput = (kind === "html" ? 2 : 10) * MiB + 16_384;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxOutput) throw error(413, "BODY_TOO_LARGE", "远程内容超过大小限制");
      parts.push(chunk.value);
    }
    const output = Buffer.concat(parts);
    const newline = output.indexOf(10);
    if (newline < 0 || newline > 16_384) throw error(502, "FETCH_FAILED", "无法获取公开网页内容，请检查网络或使用浏览器扩展");
    const metadata = JSON.parse(output.subarray(0, newline).toString("utf8"));
    if (metadata.error) throw error(metadata.error.status, metadata.error.code, metadata.error.message);
    if (await child.exited !== 0 || typeof metadata.finalUrl !== "string" || typeof metadata.mime !== "string") throw error(502, "FETCH_FAILED", "获取远程内容失败");
    return { bytes: output.subarray(newline + 1), finalUrl: checkedUrl(metadata.finalUrl).href, mime: metadata.mime };
  } catch (cause) {
    if (signal.aborted) throw error(499, "CANCELLED", "采集已取消");
    if (cause instanceof ReferenceImportError) throw cause;
    throw error(502, "FETCH_FAILED", "无法获取公开网页内容，请检查网络或使用浏览器扩展");
  } finally {
    clearTimeout(deadline); signal.removeEventListener("abort", abort); child.kill(); await reader.cancel().catch(() => {}); await child.exited;
  }
};

type Node = DefaultTreeAdapterMap["node"];
const cleanText = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
function textContent(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}
export function extractReferenceCandidates(html: string, pageUrl: string) {
  const document = parse(html);
  const elements: DefaultTreeAdapterMap["element"][] = [];
  const pending: Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!);
  }
  const attrs = (element: DefaultTreeAdapterMap["element"]) => Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
  const title = elements.find((element) => element.tagName === "title");
  const pageTitle = cleanText(title ? textContent(title) : new URL(pageUrl).hostname, 240);
  let base = pageUrl;
  const baseElement = elements.find((element) => element.tagName === "base" && attrs(element).href !== undefined);
  if (baseElement) { try { base = checkedUrl(new URL(attrs(baseElement).href!, pageUrl).href).href; } catch { /* Invalid/private base is not trusted. */ } }
  const candidates: (ReferenceCandidate & { url: string })[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (value: string | undefined, name: string | undefined) => {
    if (!value?.trim()) return;
    let url: URL;
    try { url = checkedUrl(new URL(value.trim(), base).href); } catch { return; }
    if (seen.has(url.href)) return;
    seen.add(url.href);
    if (candidates.length >= 20) { truncated = true; return; }
    const basename = url.pathname.split("/").pop() || "参考图";
    let decoded = basename;
    try { decoded = decodeURIComponent(basename); } catch { /* Keep encoded filename. */ }
    candidates.push({ id: crypto.randomUUID(), name: cleanText(name || decoded, 160) || "参考图", sourceImage: sanitizeSourceUrl(url.href), url: url.href });
  };
  for (const element of elements) {
    const attr = attrs(element);
    if (element.tagName === "img") {
      for (const field of ["currentsrc", "data-original", "data-src", "src"]) add(attr[field], attr.alt || attr.title);
      for (const field of ["srcset", "data-srcset"]) if (attr[field]) for (const item of parseSrcset(attr[field])) add(item.url, attr.alt || attr.title);
    } else if (element.tagName === "source" && attr.srcset) {
      for (const item of parseSrcset(attr.srcset)) add(item.url, undefined);
    } else if (element.tagName === "meta" && ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"].includes((attr.property || attr.name || "").toLowerCase())) add(attr.content, undefined);
  }
  return { pageTitle, candidates, warnings: [...(truncated ? ["网页候选图片超过 20 张，本次仅展示前 20 张。"] : []), ...(candidates.length ? [] : ["未发现可采集的公开图片。登录页、反爬或 JavaScript 动态图片请使用浏览器扩展。"]) ] };
}

export function detectReferenceImage(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
}

type Entry = { owner: string; result: ReferenceScan; urls: Map<string, string>; images: Map<string, { bytes: Buffer; mime: string; sourceImage: string }>; pending: Set<string>; totalBytes: number; expires: number; timer: ReturnType<typeof setTimeout> };
type Options = { fetcher?: ReferenceFetcher; now?: () => number; ttlMs?: number; maxScans?: number; maxOwnerScans?: number; maxCacheBytes?: number; maxScanBytes?: number; maxConcurrent?: number; maxOwnerConcurrent?: number; maxScansPerMinute?: number; maxGlobalScansPerMinute?: number };

export function createReferenceImportService(options: Options = {}) {
  const fetcher = options.fetcher ?? fetchReferenceResource;
  const now = options.now ?? Date.now;
  const scans = new Map<string, Entry>();
  const active = new Map<string, number>();
  const controllers = new Set<AbortController>();
  const rate = new Map<string, number[]>();
  let globalRate: number[] = [];
  let cachedBytes = 0;
  let activeCount = 0;
  const drop = (id: string) => { const entry = scans.get(id); if (entry) { clearTimeout(entry.timer); cachedBytes -= entry.totalBytes; scans.delete(id); } };
  const sweep = () => {
    for (const [id, entry] of scans) if (entry.expires <= now()) drop(id);
    for (const [owner, times] of rate) { const current = times.filter((time) => time > now() - 60_000); if (current.length) rate.set(owner, current); else rate.delete(owner); }
    globalRate = globalRate.filter((time) => time > now() - 60_000);
  };
  const run = async <T>(owner: string, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>) => {
    if (!owner || owner.length > 256) throw error(401, "OWNER_REQUIRED", "请先验证员工身份");
    if (signal?.aborted) throw error(499, "CANCELLED", "采集已取消");
    sweep();
    if (activeCount >= (options.maxConcurrent ?? 4) || (active.get(owner) || 0) >= (options.maxOwnerConcurrent ?? 2)) throw error(429, "IMPORT_BUSY", "采集任务较多，请稍后重试");
    activeCount++; active.set(owner, (active.get(owner) || 0) + 1);
    const controller = new AbortController(); controllers.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(cancel, 20_000);
    try { const result = await action(controller.signal); if (controller.signal.aborted) throw error(499, "CANCELLED", "采集已取消或超时"); return result; }
    catch (cause) { if (controller.signal.aborted) throw error(499, "CANCELLED", "采集已取消或超时"); throw cause; }
    finally { clearTimeout(deadline); signal?.removeEventListener("abort", cancel); controllers.delete(controller); activeCount--; const count = (active.get(owner) || 1) - 1; if (count) active.set(owner, count); else active.delete(owner); }
  };
  return {
    async scan(owner: string, input: string, signal?: AbortSignal): Promise<ReferenceScan> {
      return run(owner, signal, async (operationSignal) => {
        const url = checkedUrl(input);
        const times = rate.get(owner) || [];
        if (times.length >= (options.maxScansPerMinute ?? 5) || globalRate.length >= (options.maxGlobalScansPerMinute ?? 30) || (!rate.has(owner) && rate.size >= 500)) throw error(429, "SCAN_RATE_LIMIT", "链接扫描过于频繁，请稍后重试");
        times.push(now()); rate.set(owner, times); globalRate.push(now());
        if (scans.size >= (options.maxScans ?? 100) || [...scans.values()].filter((entry) => entry.owner === owner).length >= (options.maxOwnerScans ?? 3)) throw error(429, "SCAN_LIMIT", "临时采集记录已满，请等待 5 分钟后重试");
        const fetched = await fetcher(url.href, "html", operationSignal);
        operationSignal.throwIfAborted();
        if (fetched.bytes.length > 2 * MiB) throw error(413, "BODY_TOO_LARGE", "网页超过 2 MiB 限制");
        if (!["text/html", "application/xhtml+xml"].includes(fetched.mime)) throw error(415, "UNSUPPORTED_TYPE", "该链接不是公开 HTML 网页");
        const finalUrl = checkedUrl(fetched.finalUrl).href;
        const extracted = extractReferenceCandidates(fetched.bytes.toString("utf8"), finalUrl);
        const scanId = crypto.randomUUID();
        const expires = now() + (options.ttlMs ?? 5 * 60_000);
        const result: ReferenceScan = { scanId, pageUrl: sanitizeSourceUrl(finalUrl), pageTitle: extracted.pageTitle, candidates: extracted.candidates.map(({ url: _url, ...candidate }) => candidate), expiresAt: new Date(expires).toISOString(), warnings: extracted.warnings };
        // Recheck after asynchronous fetch so concurrent scans cannot overfill.
        if (scans.size >= (options.maxScans ?? 100) || [...scans.values()].filter((entry) => entry.owner === owner).length >= (options.maxOwnerScans ?? 3)) throw error(429, "SCAN_LIMIT", "临时采集记录已满，请稍后重试");
        const timer = setTimeout(() => drop(scanId), options.ttlMs ?? 5 * 60_000); timer.unref();
        scans.set(scanId, { owner, result, urls: new Map(extracted.candidates.map((candidate) => [candidate.id, candidate.url])), images: new Map(), pending: new Set(), totalBytes: 0, expires, timer });
        return structuredClone(result);
      });
    },
    async image(owner: string, scanId: string, imageId: string, signal?: AbortSignal): Promise<ReferenceImage> {
      return run(owner, signal, async (operationSignal) => {
        const entry = scans.get(scanId);
        if (!entry || entry.owner !== owner) throw error(404, "SCAN_NOT_FOUND", "采集记录不存在或已过期，请重新扫描链接");
        const url = entry.urls.get(imageId);
        const candidate = entry.result.candidates.find((item) => item.id === imageId);
        if (!url || !candidate) throw error(404, "IMAGE_NOT_FOUND", "图片不属于当前采集记录");
        if (entry.pending.has(imageId)) throw error(429, "IMAGE_BUSY", "该图片正在采集中");
        let image = entry.images.get(imageId);
        if (!image) {
          entry.pending.add(imageId);
          try {
            const fetched = await fetcher(url, "image", operationSignal);
            operationSignal.throwIfAborted();
            if (scans.get(scanId) !== entry || entry.expires <= now()) throw error(404, "SCAN_NOT_FOUND", "采集记录已过期，请重新扫描链接");
            if (fetched.bytes.length > 10 * MiB) throw error(413, "BODY_TOO_LARGE", "单张图片超过 10 MiB 限制");
            const mime = detectReferenceImage(fetched.bytes);
            if (!mime || mime !== fetched.mime) throw error(415, "UNSUPPORTED_TYPE", "图片类型或文件内容不符合 PNG、JPEG、WebP、GIF 要求");
            if (entry.totalBytes + fetched.bytes.length > (options.maxScanBytes ?? 30 * MiB)) throw error(413, "SCAN_BYTES_LIMIT", "本次采集图片累计超过 30 MiB 限制");
            if (cachedBytes + fetched.bytes.length > (options.maxCacheBytes ?? 64 * MiB)) throw error(429, "CACHE_FULL", "临时图片缓存已满，请稍后重试");
            image = { bytes: fetched.bytes, mime, sourceImage: sanitizeSourceUrl(checkedUrl(fetched.finalUrl).href) };
            entry.images.set(imageId, image); entry.totalBytes += image.bytes.length; cachedBytes += image.bytes.length;
          } finally { entry.pending.delete(imageId); }
        }
        return { id: imageId, name: candidate.name, mime: image.mime, base64: image.bytes.toString("base64"), sourcePage: entry.result.pageUrl, sourceImage: image.sourceImage, pageTitle: entry.result.pageTitle };
      });
    },
    dispose() { for (const controller of controllers) controller.abort(); for (const id of scans.keys()) drop(id); rate.clear(); globalRate = []; },
  };
}

export const referenceImportService = createReferenceImportService();
