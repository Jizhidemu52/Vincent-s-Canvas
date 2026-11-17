/**
 * Image Pipeline Presets
 * 该文件定义了系统的核心生成管线，直接将模型与底层协议参数强绑定。
 * 任何前端的操作都将路由至这些预设，禁止前端直接修改参数。
 */

export const IMAGE_PIPELINES = {
  fast: {
    modelId: "gemini-nano-banana-2.1",
    params: {
      size: "1024x1024",
      resolution: "1k",
      // Nano 协议仅支持极简参数，无需多余 field
    },
    description: "极致速度，适合预览与快速配色迭代"
  },
  refined: {
    modelId: "gpt-image-2.6-sunburst",
    params: {
      size: "2048x2048",
      resolution: "2k",
      quality: "max",
      complexity: "high"
    },
    description: "精细出图，适合最终定稿与结构重构"
  },
  refined_ultra: {
    modelId: "gpt-image-2.6-sunburst",
    params: {
      size: "3840x2160",
      resolution: "4k",
      quality: "max",
      complexity: "high"
    },
    description: "极致画质，用于最终定稿"
  }
} as const;

export type PipelineKey = keyof typeof IMAGE_PIPELINES;
