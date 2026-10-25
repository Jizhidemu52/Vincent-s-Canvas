import type { PromptInput } from "../../shared/prompt-contracts";
import type { PromptSource, PromptTargetModel } from "./prompt-compiler";
import { hasImageTransparency, ImageResultProcessingError } from "./image-result-processing";
import { PromptOptimizationError } from "./prompt-safety";

/** Scene choices outrank browser guesses. Only the primary artwork supplies the background. */
export async function promptImageBackground(input: PromptInput, target: PromptTargetModel,
  readPrimary: () => Promise<PromptSource>, parameters: Record<string, unknown>) {
  if (input.mode !== "edit" || input.hasMask || !["pattern-extract", "pattern-colorway"].includes(input.scene)) return parameters;
  const supportsBackground = !target.workflowConfigId && (target.protocol === "openai" && /^gpt-image-(?:1|1-mini|1\.5|2|2\.5-flare|2\.5-sunburst)$/.test(target.modelId)
    || target.protocol === "apimart" && /^gpt-image-2\.5-(?:flare|sunburst)$/.test(target.modelId));
  if (input.scene === "pattern-extract" && input.fields.extractBackground === "白底") {
    const result = { ...parameters };
    // Remove stale automatic transparency even on a route without native background parameters.
    if (supportsBackground) result.background = "opaque";
    else delete result.background;
    return result;
  }
  if (input.scene === "pattern-extract" && input.fields.extractBackground !== "保留底色") return parameters;
  let transparent: boolean;
  try { transparent = await hasImageTransparency(await readPrimary()); }
  catch (error) {
    if (error instanceof ImageResultProcessingError) throw new PromptOptimizationError("IMAGE_INPUT_INSPECTION_FAILED", `原图透明度无法安全核验，尚未提交生图：${error.message}`, 422);
    throw error;
  }
  if (!transparent) {
    const result = { ...parameters };
    if (supportsBackground) result.background = "opaque";
    else delete result.background;
    return result;
  }
  if (!supportsBackground) throw new PromptOptimizationError("IMAGE_TRANSPARENCY_UNSUPPORTED", "此原图含透明背景，当前渠道没有已接入的透明输出参数；请切换支持透明背景的模型，尚未提交生图");
  if (parameters.output_format === "jpeg") throw new PromptOptimizationError("IMAGE_TRANSPARENCY_FORMAT_CONFLICT", "保留透明背景不能导出 JPEG，请选择 PNG 或 WebP，尚未提交生图");
  return { ...parameters, background: "transparent", output_format: parameters.output_format || "png" };
}
