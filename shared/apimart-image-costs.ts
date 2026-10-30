import { MARK_IMAGE_PROVIDER_ID } from "./mark-image-models";

export type ApimartImageCost = { rmbPerImage: number };

/** User-provided per-image RMB costs for this provider only; internal employee credits are separate. */
export function getApimartImageCost(providerId: unknown, modelId: unknown): ApimartImageCost | null {
  if (providerId !== MARK_IMAGE_PROVIDER_ID) return null;
  switch (modelId) {
    case "gpt-image-2": return { rmbPerImage: 0.05368 };
    case "gpt-image-2.5-flare":
    case "gpt-image-2.5-sunburst": return { rmbPerImage: 0.1342 };
    case "gemini-3.1-flash-image-preview":
    case "gemini-3.1-flash-image-preview-official": return { rmbPerImage: 0.3355 };
    default: return null;
  }
}
