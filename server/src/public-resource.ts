import { fileURLToPath } from "node:url";
import { PublicFetchError, validatePublicUrl } from "./reference-import/public-fetch.mjs";

export type PublicResourceKind = "html" | "image" | "provider-image" | "provider-media";
export type PublicResource = { bytes: Buffer; mime: string; finalUrl: string };
export type PublicResourceOptions = { kind: PublicResourceKind; maxBytes: number; timeoutMs: number; signal?: AbortSignal };
export class PublicResourceError extends Error {
  constructor(public status: number, public code: string, message: string, public httpStatus?: number) { super(message); this.name = "PublicResourceError"; }
}

/** Native Node owns the pinned DNS/TLS socket. Never inherit proxy credentials,
 * NODE_OPTIONS or TLS-disable flags from the API/Worker process. */
export async function fetchPublicBytes(url: string, options: PublicResourceOptions): Promise<PublicResource> {
  try { validatePublicUrl(url); }
  catch (cause) {
    if (cause instanceof PublicFetchError) throw new PublicResourceError(cause.status, cause.code, cause.message);
    throw cause;
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 200 * 1024 * 1024
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 240_000) {
    throw new PublicResourceError(400, "INVALID_DOWNLOAD_LIMIT", "远程下载限制无效");
  }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const node = Bun.which("node");
  if (!node) throw new PublicResourceError(503, "NATIVE_NODE_REQUIRED", "安全下载需要原生 Node.js 运行环境");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const child = Bun.spawn([node, fileURLToPath(new URL("./reference-import/fetch-worker.mjs", import.meta.url))], {
    stdin: new Blob([JSON.stringify({ url, kind: options.kind, maxBytes: options.maxBytes, timeoutMs: options.timeoutMs })]),
    stdout: "pipe", stderr: "ignore", env,
  });
  const reader = child.stdout.getReader();
  const abort = () => { child.kill(); void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > options.maxBytes + 16_384) throw new PublicResourceError(413, "BODY_TOO_LARGE", "远程内容超过大小限制");
      chunks.push(chunk.value);
    }
    const output = Buffer.concat(chunks);
    const newline = output.indexOf(10);
    if (newline < 0 || newline > 16_384) throw new PublicResourceError(502, "FETCH_FAILED", "无法安全下载远程内容");
    const metadata = JSON.parse(output.subarray(0, newline).toString("utf8"));
    if (metadata.error) throw new PublicResourceError(metadata.error.status, metadata.error.code, metadata.error.message,
      Number.isInteger(metadata.error.httpStatus) && metadata.error.httpStatus >= 100 && metadata.error.httpStatus <= 599 ? metadata.error.httpStatus : undefined);
    if (await child.exited !== 0 || typeof metadata.finalUrl !== "string" || typeof metadata.mime !== "string") {
      throw new PublicResourceError(502, "FETCH_FAILED", "无法安全下载远程内容");
    }
    const bytes = output.subarray(newline + 1);
    if (bytes.length > options.maxBytes) throw new PublicResourceError(413, "BODY_TOO_LARGE", "远程内容超过大小限制");
    return { bytes, finalUrl: validatePublicUrl(metadata.finalUrl).href, mime: metadata.mime };
  } catch (cause) {
    if (signal.aborted) throw new PublicResourceError(options.signal?.aborted ? 499 : 504, options.signal?.aborted ? "CANCELLED" : "DOWNLOAD_TIMEOUT", options.signal?.aborted ? "下载已取消" : "远程下载超时");
    if (cause instanceof PublicResourceError) throw cause;
    throw new PublicResourceError(502, "FETCH_FAILED", "无法安全下载远程内容（网络、证书或响应异常）");
  } finally {
    signal.removeEventListener("abort", abort);
    child.kill();
    await reader.cancel().catch(() => undefined);
    await child.exited;
  }
}
