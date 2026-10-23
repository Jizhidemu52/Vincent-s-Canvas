import { decodeWorkflowImage } from "./workflow-runtime";
import type { GenerationTiming } from "./generation-timing";
import { providerImageMimeType } from "./provider-image-result";
import { detectReferenceImage } from "./reference-import";
import { fetchPublicBytes, PublicResourceError } from "./public-resource";
import type { PublicResourceOptions } from "./public-resource";

export const MAX_PROVIDER_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_PROVIDER_MEDIA_BYTES = 200 * 1024 * 1024;

async function downloadProviderBytes(url: string, options: PublicResourceOptions, downloadBytes: typeof fetchPublicBytes) {
  try { return await downloadBytes(url, options); }
  catch (error) {
    if (error instanceof PublicResourceError && error.code === "REMOTE_HTTP_ERROR" && error.httpStatus !== undefined) {
      throw Object.assign(new Error(`结果下载返回 HTTP ${error.httpStatus}`), { code: "RESULT_DOWNLOAD_HTTP_ERROR", httpStatus: error.httpStatus });
    }
    throw error;
  }
}

/** Decode inline images locally; time only the branch that downloads a result. */
export async function fetchProviderResult(url: string, timing?: GenerationTiming, downloadBytes = fetchPublicBytes) {
  if (url.length > Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 512) throw new PublicResourceError(413, "BODY_TOO_LARGE", "模型图片超过 50 MiB 限制");
  const inlineImage = decodeWorkflowImage(url);
  if (inlineImage) {
    if (inlineImage.bytes.length > MAX_PROVIDER_IMAGE_BYTES) throw new PublicResourceError(413, "BODY_TOO_LARGE", "模型图片超过 50 MiB 限制");
    return { ...inlineImage, mimeType: providerImageMimeType(inlineImage.bytes, inlineImage.mimeType) };
  }
  if (url.startsWith("data:"))
    throw new Error("Provider 返回了无法识别的内联图片");
  const download = async () => {
    const { bytes, mime } = await downloadProviderBytes(url, { kind: "provider-image", maxBytes: MAX_PROVIDER_IMAGE_BYTES, timeoutMs: 60_000 }, downloadBytes);
    if (bytes.length > MAX_PROVIDER_IMAGE_BYTES) throw new PublicResourceError(413, "BODY_TOO_LARGE", "模型图片超过 50 MiB 限制");
    if (!detectReferenceImage(bytes)) throw new PublicResourceError(415, "UNSUPPORTED_TYPE", "模型返回的内容不是支持的图片");
    return { bytes, mimeType: providerImageMimeType(bytes, mime) };
  };
  return timing ? timing.measure("result_download", download) : download();
}

export async function fetchProviderMediaResult(url: string, timing?: GenerationTiming, downloadBytes = fetchPublicBytes) {
  const download = async () => {
    const { bytes, mime } = await downloadProviderBytes(url, { kind: "provider-media", maxBytes: MAX_PROVIDER_MEDIA_BYTES, timeoutMs: 180_000 }, downloadBytes);
    if (bytes.length > MAX_PROVIDER_MEDIA_BYTES) throw new PublicResourceError(413, "BODY_TOO_LARGE", "模型音视频超过 200 MiB 限制");
    return { bytes, mimeType: mime };
  };
  return timing ? timing.measure("result_download", download) : download();
}
