import { isPublicHttpUrl } from "./apimart-upload";
import { providerImageMimeType } from "./provider-image-result";
import { fetchProviderSubmission } from "./provider-submission-transport";

/** Download an existing result with the verified native Node socket used by uploads.
 * No provider credentials or submission payload enter this GET. A failure leaves
 * the original upstream identity available for recovery; it never starts a job.
 */
export async function downloadApiMartImageResult(
  url: string,
  timeoutMs = 120_000,
  runtime: { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {},
) {
  if (!isPublicHttpUrl(url)) throw Object.assign(new Error("APIMart 图片结果地址无效，不能恢复下载"), { code: "PROVIDER_RESULT_URL_INVALID" });
  const response = await (runtime.fetch || fetchProviderSubmission)(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`APIMart 图片下载失败：${response.status}`), { code: "RESULT_DOWNLOAD_HTTP_ERROR", httpStatus: response.status });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mimeType: providerImageMimeType(bytes, response.headers.get("content-type")?.split(";")[0]) };
}
