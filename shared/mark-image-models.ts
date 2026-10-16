/** Dedicated provider identity keeps Mark credentials and model choices separate from other channels. */
export const MARK_IMAGE_PROVIDER_ID = "9567f5da-bb4d-4e4b-b680-c7184d00a001";
export const MARK_IMAGE_PROVIDER_NAME = "APIMart 平台";
export const MARK_IMAGE_BASE_URL = "https://api.apimart.ai/v1";
export const MARK_IMAGE_MODELS = [
  { modelId: "gpt-image-2.5-flare", name: "aplmart-gpt2.5-flare", description: "快速出方案与常规改图", defaultEnabled: true },
  { modelId: "gpt-image-2.5-sunburst", name: "aplmart-gpt2.5-sunburst", description: "精细改图与细节表现", defaultEnabled: true },
  { modelId: "gemini-nano-banana-2.1", name: "aplmart-nano2.1", description: "复杂材质与多参考改图", defaultEnabled: true },
] as const;
export const MARK_EXTRA_IMAGE_MODELS = [
  { modelId: "gpt-image-2", name: "aplmart-gpt2", description: "日常最通用模型", defaultEnabled: true },
  { modelId: "grok-imagine-image-2.0", name: "aplmart-grok2", description: "文生图与简单改图", defaultEnabled: false },
] as const;

/** A single isolated Mark credential powers explicitly selected image, text, and video models. */
export const MARK_PLATFORM_MODELS = [
  ...MARK_IMAGE_MODELS.map(model => ({ ...model, capabilities: ["generate", "edit", "batch"] as const })),
  { modelId: "gpt-6-astra", name: "aplmart-gpt6-astra", description: "文字对话与设计需求整理", defaultEnabled: true, capabilities: ["chat"] as const },
  { modelId: "happyhorse-1.1", name: "aplmart-happyhorse1.1", description: "图生视频与商品动态展示", defaultEnabled: true, capabilities: ["video"] as const },
  // Append new presets: demo configuration UUIDs are assigned by this stable order.
  { modelId: "midjourney-blend", name: "aplmart-mj-blend", description: "多图创意融合（无需提示词）", defaultEnabled: true, capabilities: ["generate"] as const },
  ...MARK_EXTRA_IMAGE_MODELS.map(model => ({ ...model, capabilities: ["generate", "edit", "batch"] as const })),
  { modelId: "gemini-3.1-flash-image-preview-official", name: "aplmart-nano2", description: "日常改款与多图参考", defaultEnabled: true, capabilities: ["generate", "edit", "batch"] as const },
  { modelId: "claude-sonnet-5-5", name: "aplmart-claude-sonnet-5-5", description: "文字对话与图文理解", defaultEnabled: true, capabilities: ["chat", "vision", "tools"] as const },
] as const;
