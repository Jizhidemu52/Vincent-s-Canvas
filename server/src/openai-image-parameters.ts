import { normalizeOpenTokenImageSize } from "./opentoken-image";

/** The OpenAI-compatible adapter supports quality, not APIMart resolution. */
export function openAiImageParameters(parameters: Record<string, unknown>, modelId?: string) {
  // The configured non-preview Gemini alias has no documented Images API settings.
  if (modelId === "gemini-3.1-flash-image") return {};
  const value = String(parameters.quality || "").toLowerCase();
  const quality = ["auto", "low", "medium", "high"].includes(value) ? value
    : parameters.resolution === "4k" ? "high" : parameters.resolution === "2k" ? "medium" : "auto";
  return { size: normalizeOpenTokenImageSize(String(parameters.size || "auto")), quality: quality as "auto" | "low" | "medium" | "high",
    ...(parameters.background === "transparent" ? { background: "transparent" as const, output_format: "png" as const } : {}),
  };
}
