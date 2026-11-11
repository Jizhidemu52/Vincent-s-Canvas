import { isPublicHttpUrl } from "./apimart-upload";
import { preflightVideoTask } from "./video-task-preflight";
import type { ProviderVideoSource, SupportedVideoModelId, VideoProviderParameters } from "./video-models";

/** Admission may use owned-asset placeholders; only the Worker issues real URLs. */
export function preflightVideoSources(model: SupportedVideoModelId, prompt: string, parameters: VideoProviderParameters, sources: ProviderVideoSource[]) {
  return preflightVideoTask({ model, prompt, parameters, sources });
}

export async function prepareVideoProviderSources(input: { model: SupportedVideoModelId; prompt: string; parameters: VideoProviderParameters; sources: ProviderVideoSource[]; baseUrl: string; apiKey: string }, _runtime: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  // No provider upload fallback: all modalities use the Worker's owned URL grants.
  preflightVideoSources(input.model, input.prompt, input.parameters, input.sources);
  return input.sources.map(source => {
    const publicUrl = source.publicUrl?.trim() || "";
    if (!isPublicHttpUrl(publicUrl)) throw new Error("视频素材需要上游可访问的公开 HTTP(S) URL；请配置自有素材入口后重试，尚未提交或扣费");
    return { ...source, publicUrl };
  });
}
