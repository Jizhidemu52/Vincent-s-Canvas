import { isIP } from "node:net";

export const APIMART_VIDEO_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export function isApiMartImageMimeType(mimeType: string) {
  return Object.hasOwn(extensions, mimeType);
}

export function validateApiMartVideoImage(source: { bytes: Uint8Array; mimeType: string }) {
  if (!isApiMartImageMimeType(source.mimeType)) throw new Error("视频参考图仅支持 JPEG、PNG、WebP 或 GIF 格式");
  if (!source.bytes.byteLength || source.bytes.byteLength > APIMART_VIDEO_IMAGE_MAX_BYTES) throw new Error("视频参考图必须非空且不超过 10MB");
}

/** Upload bytes to the configured APIMart service; never forward private storage URLs. */
export async function uploadApiMartImage(input: {
  baseUrl: string;
  apiKey: string;
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
}, runtime: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("APIMart 视频服务端凭据未配置");
  validateApiMartVideoImage(input);
  const file = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });
  const filename = input.filename?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "") || `reference.${extensions[input.mimeType]}`;
  const form = new FormData();
  form.append("file", file, filename);
  const response = await (runtime.fetch || fetch)(`${input.baseUrl.replace(/\/+$/, "")}/uploads/images`, {
    method: "POST", headers: { authorization: `Bearer ${input.apiKey}` }, body: form,
    redirect: "error", signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`APIMart 参考图上传失败（${response.status}），尚未提交视频生成`);
  const result = await response.json().catch(() => null) as { url?: unknown } | null;
  if (typeof result?.url !== "string" || !isPublicHttpsUrl(result.url)) throw new Error("APIMart 参考图上传未返回公开 HTTPS 地址，尚未提交视频生成");
  return result.url;
}

function isPublicHttpsUrl(value: string) {
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
