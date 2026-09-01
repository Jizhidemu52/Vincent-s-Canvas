import {
  preflightVideoProviderRequest,
  type ProviderVideoSource,
  type SupportedVideoModelId,
  type VideoProviderParameters,
} from "./video-models";

export type VideoTaskPreflightInput = {
  model: SupportedVideoModelId;
  prompt: string;
  parameters?: VideoProviderParameters;
  sources?: ProviderVideoSource[];
};

export function preflightVideoTask(input: VideoTaskPreflightInput) {
  if (!input.prompt.trim()) throw new Error("Video prompt is required");
  return preflightVideoProviderRequest(
    input.model,
    input.prompt.trim(),
    input.parameters || {},
    input.sources || [],
  );
}
