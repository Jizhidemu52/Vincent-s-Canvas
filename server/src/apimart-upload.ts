import { isIP } from "node:net";
import { fetchProviderSubmission, readProviderSubmissionDiagnostics } from "./provider-submission-transport";

export const APIMART_VIDEO_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const APIMART_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function uploadTransportFailure(cause: unknown, purposeName: "图片" | "视频") {
  const diagnostics = readProviderSubmissionDiagnostics(cause);
  const errorName = cause instanceof Error ? cause.name : "";
  const detail = diagnostics?.phase === "http_started" || diagnostics?.phase === "response" ? "连接中断"
    : errorName === "TimeoutError" ? "超时" : "失败";
  // The upload POST is not the paid generation POST. Preserve bounded transport
  // evidence, but never carry its generic submission warning into user text.
  return Object.assign(new Error(`APIMart 参考图上传${detail}，尚未提交${purposeName}生成`, { cause }), diagnostics || {},
    errorName === "TimeoutError" || errorName === "AbortError" ? { name: errorName } : {});
}

export function isApiMartImageMimeType(mimeType: string) {
  return Object.hasOwn(extensions, mimeType);
}

export function validateApiMartVideoImage(source: { bytes: Uint8Array; mimeType: string }) {
  if (!isApiMartImageMimeType(source.mimeType)) throw new Error("视频参考图仅支持 JPEG、PNG、WebP 或 GIF 格式");
  if (!source.bytes.byteLength || source.bytes.byteLength > APIMART_VIDEO_IMAGE_MAX_BYTES) throw new Error("视频参考图必须非空且不超过 10MB");
}

export function validateApiMartGenerationImage(source: { bytes: Uint8Array; mimeType: string }) {
  if (!isApiMartImageMimeType(source.mimeType)) throw new Error("图片参考图仅支持 JPEG、PNG、WebP 或 GIF 格式");
  if (!source.bytes.byteLength || source.bytes.byteLength > APIMART_IMAGE_MAX_BYTES) throw new Error("图片参考图必须非空且不超过 20MB");
}

/** Upload bytes to the configured APIMart service; never forward private storage URLs. */
export async function uploadApiMartImage(input: {
  baseUrl: string;
  apiKey: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
  purpose?: "image" | "video";
}, runtime: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Promise<string> {
  const purposeName = input.purpose === "image" ? "图片" : "视频";
  if (!input.apiKey.trim()) throw new Error(`APIMart ${purposeName}服务端凭据未配置`);
  if (input.purpose === "image") validateApiMartGenerationImage(input);
  else validateApiMartVideoImage(input);
  // Blob already snapshots a view. Do not create a second full-size typed-array
  // copy first, and keep byteOffset/byteLength when the input is a subarray.
  const file = new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mimeType });
  // The provider builds its CDN path from this multipart name. Keep that wire
  // name ASCII-only; the original filename remains in our asset metadata.
  const filename = `reference.${extensions[input.mimeType]}`;
  const form = new FormData();
  form.append("file", file, filename);
  const response = await (runtime.fetch || fetchProviderSubmission)(`${input.baseUrl.replace(/\/+$/, "")}/uploads/images`, {
    method: "POST", headers: { authorization: `Bearer ${input.apiKey}` }, body: form,
    redirect: "error", signal: AbortSignal.timeout(180_000),
  }).catch((error: unknown) => {
    throw uploadTransportFailure(error, purposeName);
  });
  if (!response.ok) {
    // The native transport exposes a live stream; close it before the upload
    // promise settles so a failed concurrent batch leaves no unread response.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`APIMart 参考图上传失败（${response.status}），尚未提交${purposeName}生成`);
  }
  const result = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) return null;
    throw uploadTransportFailure(error, purposeName);
  }) as { url?: unknown } | null;
  if (typeof result?.url !== "string" || !isPublicHttpsUrl(result.url)) throw new Error(`APIMart 参考图上传未返回公开 HTTPS 地址，尚未提交${purposeName}生成`);
  return normalizeApiMartImageUrl(result.url);
}

/** Preserve valid escapes/signatures; encode raw Unicode, spaces and bare %. */
export function normalizeApiMartImageUrl(value: string): string {
  const normalized = new URL(value.replace(/%(?![\da-f]{2})/gi, "%25")).href;
  if (!isPublicHttpUrl(normalized)) throw new Error("参考图必须为公开 HTTP(S) URL");
  return normalized;
}

/** Generation accepts public HTTP(S); uploads themselves still require HTTPS. */
export function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    url.protocol = "https:";
    return isPublicHttpsUrl(url.toString());
  } catch {
    return false;
  }
}

export function isPublicHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (isIP(hostname) === 4) {
      const [a, b] = hostname.split(".").map(Number);
      return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
    }
    if (isIP(hostname) === 6) return /^[23][0-9a-f]{3}:/.test(hostname);
    return hostname.includes(".") && !/(^|\.)(localhost|local|internal|lan)$/.test(hostname);
  } catch {
    return false;
  }
}
