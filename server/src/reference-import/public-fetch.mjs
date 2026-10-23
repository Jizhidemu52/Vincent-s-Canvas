// This module must run under native Node. Bun's socket/lookup compatibility is
// deliberately not part of the SSRF security boundary.
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import ipaddr from "ipaddr.js";

export class PublicFetchError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (code, message, status = 400) => new PublicFetchError(status, code, message);

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    // Azure's platform virtual IP is globally numbered but is not a public
    // Internet destination (WireServer / host platform services).
    if (parsed.kind() === "ipv4" && parsed.toString() === "168.63.129.16") return false;
    // Reject mapped IPv6 entirely, even when its mapped IPv4 is public. Also
    // rejects transition, link-local, unique-local, reserved and multicast IPs.
    if (parsed.range() !== "unicast") return false;
    // Only currently allocated global-unicast IPv6 (2000::/3), excluding the
    // protocol-assignment/documentation/transition ranges tracked by ipaddr.
    if (parsed.kind() === "ipv6" && !parsed.match(ipaddr.parse("2000::"), 3)) return false;
    return true;
  } catch { return false; }
}

export function validatePublicUrl(input) {
  if (typeof input !== "string" || input.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(input)) throw fail("INVALID_URL", "请输入完整的公开 HTTP/HTTPS 网页链接");
  let url;
  try { url = new URL(input); } catch { throw fail("INVALID_URL", "网页链接格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw fail("UNSAFE_URL", "仅支持无登录凭据、标准端口的公开 HTTP/HTTPS 链接");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.includes("%") || (!isIP(hostname) && (!hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(hostname) || hostname === "metadata.google.internal"))) throw fail("UNSAFE_URL", "不能采集本机、内网或特殊用途地址");
  if (isIP(hostname) && !isPublicAddress(hostname)) throw fail("UNSAFE_ADDRESS", "不能采集本机、内网或特殊用途地址");
  url.hash = "";
  return url;
}

export async function resolvePublicAddress(url, resolver = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  let addresses;
  try { addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolver(hostname, { all: true, verbatim: true }); }
  catch { throw fail("DNS_FAILED", "无法解析网页地址", 502); }
  if (!addresses.length || addresses.some(({ address, family }) => ![4, 6].includes(family) || isIP(address) !== family || !isPublicAddress(address))) throw fail("UNSAFE_ADDRESS", "网页地址解析到了内网或特殊用途网络");
  return addresses[0];
}

function byteLimit(maxBytes) {
  let total = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    callback(total > maxBytes ? fail("BODY_TOO_LARGE", "远程内容超过大小限制", 413) : null, chunk);
  } });
}

/** Fresh socket, checked address pinned at lookup; original host remains for
 * Host/SNI/certificate identity. No global agent, proxy, cookies or credentials.
 * Exported separately to exercise actual native sockets in offline fixtures. */
export async function requestPinned(url, address, { maxBytes, signal, kind }) {
  if (process.versions.bun) throw fail("NATIVE_NODE_REQUIRED", "网页采集需要原生 Node.js 运行环境", 503);
  const secure = url.protocol === "https:";
  const agent = secure ? new https.Agent({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} }) : new http.Agent({ keepAlive: false, proxyEnv: {} });
  const response = await new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(url, {
      method: "GET", agent, signal, rejectUnauthorized: true,
      // Never allow a DNS second lookup or automatic fallback to another IP.
      autoSelectFamily: false,
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { accept: kind === "html" ? "text/html,application/xhtml+xml" : "image/png,image/jpeg,image/webp,image/gif", "accept-encoding": "gzip, deflate, br", "user-agent": "CanvasReferenceImport/1.0", connection: "close" },
      maxHeaderSize: 16 * 1024,
    });
    request.once("error", (error) => { agent.destroy(); reject(error); });
    request.once("response", resolve);
    request.end();
  });
  try {
    const status = response.statusCode || 502;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      return { status, location, mime: "", bytes: Buffer.alloc(0) };
    }
    if (status < 200 || status >= 300) throw fail("REMOTE_HTTP_ERROR", `网页服务器返回 HTTP ${status}，请使用浏览器扩展采集需要登录的页面`, 502);
    const mime = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (kind === "html" ? !["text/html", "application/xhtml+xml"].includes(mime) : !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) throw fail("UNSUPPORTED_TYPE", kind === "html" ? "该链接不是公开 HTML 网页" : "仅支持 PNG、JPEG、WebP 和 GIF 原图", 415);
    const contentLength = response.headers["content-length"];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) throw fail("BODY_TOO_LARGE", "远程内容超过大小限制", 413);
    const encoding = String(response.headers["content-encoding"] || "identity").trim().toLowerCase();
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
    if (!decoder && encoding !== "identity") throw fail("UNSUPPORTED_ENCODING", "网页使用了不支持的压缩格式", 415);
    const chunks = [];
    const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    const streams = [response, byteLimit(maxBytes)];
    if (decoder) streams.push(decoder);
    streams.push(byteLimit(maxBytes), sink);
    await pipeline(streams, { signal });
    return { status, mime, bytes: Buffer.concat(chunks) };
  } finally { response.destroy(); agent.destroy(); }
}

export async function fetchPublicResource(input, { maxBytes, signal, kind }, resolver = lookup) {
  let url = validatePublicUrl(input);
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    const address = await resolvePublicAddress(url, resolver);
    signal?.throwIfAborted();
    const response = await requestPinned(url, address, { maxBytes, signal, kind });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { ...response, finalUrl: url.href };
    if (redirects >= 3 || !response.location) throw fail("TOO_MANY_REDIRECTS", "网页重定向过多或目标无效", 422);
    try { url = validatePublicUrl(new URL(response.location, url).href); }
    catch (error) { if (error instanceof PublicFetchError) throw error; throw fail("INVALID_REDIRECT", "网页重定向目标无效", 422); }
  }
}
