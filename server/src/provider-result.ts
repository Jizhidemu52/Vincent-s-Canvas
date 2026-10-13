import { decodeWorkflowImage } from "./workflow-runtime";
import type { GenerationTiming } from "./generation-timing";

/** Decode inline images locally; time only the branch that downloads a result. */
export async function fetchProviderResult(url: string, timing?: GenerationTiming) {
  const inlineImage = decodeWorkflowImage(url);
  if (inlineImage) return inlineImage;
  if (url.startsWith("data:"))
    throw new Error("Provider 返回了无法识别的内联图片");
  const download = async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok)
      throw new Error(`下载 Provider 结果失败：${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png",
    };
  };
  return timing ? timing.measure("result_download", download) : download();
}
