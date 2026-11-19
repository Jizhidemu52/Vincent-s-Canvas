/** Dedicated provider identity keeps Mark credentials and model choices separate from other channels. */
export const MARK_IMAGE_PROVIDER_ID = "9567f5da-bb4d-4e4b-b680-c7184d00a001";
export const MARK_IMAGE_PROVIDER_NAME = "APIMart 平台";
export const MARK_IMAGE_BASE_URL = "https://api.apimart.ai/v1";
export const MARK_IMAGE_MODELS = [
  { demoOrdinal: 1, modelId: "gpt-image-2.5-flare", name: "aplmart-gpt2.5-flare", description: "快速出方案与常规改图", defaultEnabled: true },
  { demoOrdinal: 2, modelId: "gpt-image-2.5-sunburst", name: "aplmart-gpt2.5-sunburst", description: "精细改图与细节表现", defaultEnabled: true },
  { demoOrdinal: 3, modelId: "gemini-nano-banana-2.1", name: "aplmart-nano2.1", description: "复杂材质与多参考改图", defaultEnabled: true },
] as const;
export const MARK_EXTRA_IMAGE_MODELS = [
  { demoOrdinal: 7, modelId: "gpt-image-2", name: "aplmart-gpt2", description: "日常最通用模型", defaultEnabled: true },
] as const;

export const MARK_GPT26_IMAGE_MODELS = [
  { demoOrdinal: 11, modelId: "gpt-image-2.6-flare", name: "aplmart-gpt2.6-flare", description: "速度优先，适合快速迭代", defaultEnabled: true },
  { demoOrdinal: 12, modelId: "gpt-image-2.6-sunburst", name: "aplmart-gpt2.6-sunburst", description: "细节与编辑一致性优先", defaultEnabled: true },
] as const;

/** A single isolated Mark credential powers explicitly selected image, text, and video models. */
export const MARK_PLATFORM_MODELS = [
  ...MARK_IMAGE_MODELS.map(model => ({ ...model, capabilities: ["generate", "edit", "batch"] as const })),
  { demoOrdinal: 4, modelId: "gpt-6-astra", name: "aplmart-gpt6-astra", description: "文字对话与设计需求整理", defaultEnabled: true, capabilities: ["chat"] as const },
  { demoOrdinal: 5, modelId: "happyhorse-1.1", name: "aplmart-happyhorse1.1", description: "图生视频与商品动态展示", defaultEnabled: true, capabilities: ["video"] as const },
  { demoOrdinal: 6, modelId: "midjourney-blend", name: "aplmart-mj-blend", description: "多图创意融合（无需提示词）", defaultEnabled: true, capabilities: ["generate"] as const },
  ...MARK_EXTRA_IMAGE_MODELS.map(model => ({ ...model, capabilities: ["generate", "edit", "batch"] as const })),
  { demoOrdinal: 10, modelId: "claude-sonnet-5-5", name: "aplmart-claude-sonnet-5-5", description: "文字对话与图文理解", defaultEnabled: true, capabilities: ["chat", "vision", "tools"] as const },
  ...MARK_GPT26_IMAGE_MODELS.map(model => ({ ...model, capabilities: ["generate", "edit", "batch"] as const })),
  { demoOrdinal: 16, modelId: "mai-image-2.7-flash", name: "aplmart-mai2.7-flash", description: "快速出图与最多 5 图参考编辑；支持 1K / 2K 文生图", defaultEnabled: true, capabilities: ["generate", "edit", "batch"] as const },
  { demoOrdinal: 14, modelId: "seedream-5-5", name: "豆包生图", description: "图片生成、参考图编辑与透明背景；图层拆分使用独立工作区", defaultEnabled: false, capabilities: ["generate", "edit"] as const },
  { demoOrdinal: 15, modelId: "gemini-4-carbon", name: "aplmart-gemini-4-carbon", description: "文字对话、图文理解与工具调用", defaultEnabled: true, capabilities: ["chat", "vision", "tools"] as const },
] as const;
