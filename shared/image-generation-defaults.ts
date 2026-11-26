export type ImageModelDefaults = {
  size?: string;
  quality?: string;
  resolution?: string;
  background?: "auto" | "opaque" | "transparent";
  output_format?: "png" | "jpeg" | "webp";
  complexity?: "low" | "medium" | "high";
  moderation?: "auto" | "low";
  negative_prompt?: string;
  nsfw_check?: boolean;
  official_fallback?: boolean;
  web_grounding?: boolean;
  google_search?: boolean;
  google_image_search?: boolean;
};
