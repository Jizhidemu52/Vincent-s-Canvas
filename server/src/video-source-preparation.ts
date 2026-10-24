import { isPublicHttpsUrl, uploadApiMartImage, validateApiMartVideoImage } from "./apimart-upload";
import { preflightVideoTask } from "./video-task-preflight";
import type { ProviderVideoSource, SupportedVideoModelId, VideoProviderParameters } from "./video-models";

/** APIMart documents only image uploads. Video/audio use an owned, signed public URL. */
export function preflightVideoSources(model: SupportedVideoModelId, prompt: string, parameters: VideoProviderParameters, sources: ProviderVideoSource[]) {
  const result = preflightVideoTask({ model, prompt, parameters, sources: sources.map((source) => ({ ...source, publicUrl: "asset://pending-owned-media" })) });
  for (const source of sources) {
    if (!source.mimeType.startsWith("image/") && !isPublicHttpsUrl(source.publicUrl || "")) throw new Error("视频/音频素材需要上游可访问的公开 HTTPS 地址；请配置公网素材入口后重试，尚未提交或扣费");
  }
  return result;
}

export async function prepareVideoProviderSources(input: { model: SupportedVideoModelId; prompt: string; parameters: VideoProviderParameters; sources: ProviderVideoSource[]; baseUrl: string; apiKey: string }, runtime: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  // Validate the complete request before the very first upload (including all source bytes).
  preflightVideoSources(input.model, input.prompt, input.parameters, input.sources);
  input.sources.filter((source) => source.mimeType.startsWith("image/")).forEach(validateApiMartVideoImage);
  const prepared = new Array<ProviderVideoSource>(input.sources.length);
  let nextIndex = 0, failed = false;
  let firstFailure: unknown;
  const uploadNext = async () => {
    while (!failed && nextIndex < input.sources.length) {
      const index = nextIndex++, source = input.sources[index]!;
      try {
        const publicUrl = source.mimeType.startsWith("image/")
          ? await uploadApiMartImage({ ...source, baseUrl: input.baseUrl, apiKey: input.apiKey }, runtime)
          : source.publicUrl;
        prepared[index] = { ...source, publicUrl };
      } catch (error) {
        if (!failed) { failed = true; firstFailure = error; }
      }
    }
  };
  // Preserve input order; stop starting work on failure and drain active uploads.
  await Promise.all(Array.from({ length: Math.min(3, input.sources.length) }, uploadNext));
  if (failed) throw firstFailure;
  return prepared;
}
