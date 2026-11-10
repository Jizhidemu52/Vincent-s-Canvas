import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

export type FixedToolPromptTarget = { modelId: string; protocol: string; providerId?: string; workflowConfigId?: string | null };

export const SEAMLESS_PATTERN_PROMPT = "将参考图处理成可四方连续平铺的无缝花型。保留原图的主体元素、配色、材质与绘画风格，优化边缘和元素布局，使左边缘与右边缘、上边缘与下边缘准确衔接，平铺后没有可见接缝、断裂或突兀的重复边界。输出单张平面花型单元，不要拼贴预览、边框、文字、水印或透视效果。";
export const DETAIL_ENHANCE_PROMPT = "按用户要求增强参考图现有细节和清晰度，不重新设计主体。除用户明确要求外，保留主体结构、比例、配色、图案、文字、材质与原构图；不要凭空补造纹理、文字或结构。";
export const ANGLE_CONTROL_PROMPT = "按用户指定的角度展示参考图中的同一主体。除视角变化和用户明确要求外，保留主体结构、比例、配色、材质、图案、文字及配件。未展示部分仅作合理的视角推演，不额外添加设计。";

/** Only trusted server model metadata selects this template; legacy workflows keep their input unchanged. */
export function prepareFixedToolPrompt<T extends { operationType: string; toolKey?: string; prompt: string; parameters: Record<string, unknown> }>(input: T, target?: FixedToolPromptTarget): T {
  if (!target || input.parameters.quickImageAction) return input;
  let prompt: string;
  if (input.operationType === "seamless_stitch" && input.toolKey === "seamless-stitch" && target.protocol === "apimart"
    && target.providerId === MARK_IMAGE_PROVIDER_ID
    && MARK_PLATFORM_MODELS.some(model => model.modelId === target.modelId && (model.capabilities as readonly string[]).includes("edit"))) {
    prompt = SEAMLESS_PATTERN_PROMPT;
  } else if (!target.workflowConfigId && ["openai", "apimart"].includes(target.protocol)) {
    const instruction = input.toolKey === "detail-enhance" && input.operationType === "upscale" ? DETAIL_ENHANCE_PROMPT
      : input.toolKey === "angle-control" && input.operationType === "inpaint" ? ANGLE_CONTROL_PROMPT : undefined;
    if (!instruction) return input;
    // Preserve the complete submitted text, including numbers, reference roles and user wording.
    const prefix = `${instruction}\n\n用户要求：\n`;
    prompt = input.prompt === instruction || input.prompt.startsWith(prefix) ? input.prompt
      : input.prompt.trim() ? `${prefix}${input.prompt}` : instruction;
  } else return input;
  const parameters = { ...input.parameters };
  delete parameters.promptOptimization;
  const archive = parameters.inputArchive;
  if (archive && typeof archive === "object" && !Array.isArray(archive)) {
    const saved = archive as Record<string, unknown>;
    const config = saved.config && typeof saved.config === "object" && !Array.isArray(saved.config) ? saved.config as Record<string, unknown> : {};
    parameters.inputArchive = { ...saved, effectivePrompt: prompt, config: input.toolKey === "seamless-stitch" ? { ...config, systemPrompt: "" } : { ...config } };
  }
  return { ...input, prompt, parameters };
}
