import { PromptOptimizationError } from "./prompt-safety";

type ImagePromptInput = { operationType: string; prompt: string; parameters: Record<string, unknown> };
export const isImagePromptOperation = (operationType: string) => ["image_generation", "inpaint", "batch_image", "upscale"].includes(operationType);

export function validateImagePromptExclusions(input: ImagePromptInput) {
  if (!isImagePromptOperation(input.operationType)) return "";
  const raw = input.parameters.negative_prompt;
  if (raw !== undefined && typeof raw !== "string") throw new PromptOptimizationError("INVALID_NEGATIVE_PROMPT", "排除内容必须为文字，未提交生成");
  const value = typeof raw === "string" ? raw.trim() : "";
  if (Array.from(value).length > 4_000) throw new PromptOptimizationError("INVALID_NEGATIVE_PROMPT", "排除内容最多 4000 字符，请精简后重试");
  return value;
}

/** Only the server creates this snapshot. The authoring prompt remains separate from the provider prompt. */
export function applyImagePromptExclusions<T extends ImagePromptInput>(input: T, target?: { modelId: string; protocol: string }): Omit<T, "parameters"> & { parameters: Record<string, unknown> } {
  if (!isImagePromptOperation(input.operationType)) return input;
  const parameters = { ...input.parameters };
  delete parameters.promptExclusions;
  const negativePrompt = validateImagePromptExclusions(input);
  if (!negativePrompt) { delete parameters.negative_prompt; return { ...input, parameters }; }
  const modelId = target?.modelId.trim().toLowerCase();
  if (modelId === "midjourney-blend") throw new PromptOptimizationError("NEGATIVE_PROMPT_UNSUPPORTED", "多图融合不接受文字提示词或排除内容，请改用图片生成模型");
  const native = target?.protocol === "apimart" && ["midjourney", "midjourney-v7"].includes(modelId || "");
  const prompt = native ? input.prompt : `${input.prompt}\n\n排除要求（自然语言约束）：请不要在生成结果中出现以下内容：\n${negativePrompt}`;
  if (prompt.length > 20_000) throw new PromptOptimizationError("IMAGE_PROMPT_TOO_LONG", "提示词加上排除内容超过 20000 字符，请精简后重试");
  if (native) parameters.negative_prompt = negativePrompt;
  else delete parameters.negative_prompt;
  parameters.promptExclusions = { sourcePrompt: input.prompt, negativePrompt, submittedPrompt: prompt, mode: native ? "native" : "prompt" };
  const archive = parameters.inputArchive;
  if (archive && typeof archive === "object" && !Array.isArray(archive)) parameters.inputArchive = { ...archive, submittedPrompt: prompt };
  return { ...input, prompt, parameters };
}
