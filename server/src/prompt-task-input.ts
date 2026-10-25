import { promptInputSchema, requiredPromptScene, type PromptInput } from "../../shared/prompt-contracts";
import type { PromptActor, PromptCompiler } from "./prompt-compiler";
import { PromptOptimizationError } from "./prompt-safety";
import { promptImageBackground } from "./prompt-image-background";

export type PromptTaskInput = {
  requestId: string; operationType: string; toolKey?: string; modelConfigId?: string | null;
  prompt: string; promptInput?: PromptInput; parameters: Record<string, unknown>; sourceUrls: string[];
};

/** Runs before queue admission/credit reservation; output contains no authoring rules. */
export async function preparePromptTaskInput<T extends PromptTaskInput>(compiler: PromptCompiler, actor: PromptActor, input: T): Promise<T & { userInput?: PromptInput; promptCompilationId?: string; optimized: boolean }> {
  const expectedScene = requiredPromptScene(input.toolKey);
  if (expectedScene && !input.promptInput) throw new PromptOptimizationError("PROMPT_INPUT_REQUIRED", "此场景必须提交表单设置并经过提示词优化，未提交生成");
  if (expectedScene && input.promptInput?.scene !== expectedScene) throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH", "优化场景与功能板块不一致，未提交生成");
  let parameters = { ...input.parameters };
  delete parameters.promptOptimization;
  if (!input.promptInput) return { ...input, parameters, optimized: false };
  if (!["image_generation", "inpaint", "batch_image"].includes(input.operationType)) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "此任务类型不支持提示词优化");
  if (!input.modelConfigId) throw new PromptOptimizationError("MODEL_REQUIRED", "请先选择图片模型");
  const promptInput = promptInputSchema.parse(input.promptInput);
  const expectedMode = input.operationType === "image_generation" ? "generate" : "edit";
  if (promptInput.mode !== expectedMode) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "优化模式与实际生成操作不一致，未提交生成");
  const archive = parameters.inputArchive && typeof parameters.inputArchive === "object" ? parameters.inputArchive as Record<string, unknown> : undefined;
  const archiveMask = archive?.maskReferenceIndex;
  if (archiveMask !== undefined) {
    if (typeof archiveMask !== "number" || (promptInput.maskReferenceIndex !== undefined && promptInput.maskReferenceIndex !== archiveMask)) throw new PromptOptimizationError("PROMPT_MASK_INVALID", "优化蒙版与生成蒙版索引不一致");
    promptInput.maskReferenceIndex = archiveMask;
    promptInput.hasMask = true;
  } else if (promptInput.hasMask) throw new PromptOptimizationError("PROMPT_MASK_INVALID", "生成输入缺少优化时使用的选区蒙版");
  const compilation = await compiler.compile(actor, { requestId: input.requestId, modelConfigId: input.modelConfigId,
    toolKey: input.toolKey, promptInput, sourceUrls: input.sourceUrls });
  if (compilation.status !== "success" || !compilation.prompt) throw new PromptOptimizationError(compilation.errorCode || "PROMPT_OPTIMIZING",
    compilation.message || "提示词仍在优化，未提交生成，请查询原请求", compilation.status === "failed" ? 422 : 409);
  if (["pattern-extract", "pattern-colorway"].includes(promptInput.scene)) {
    const target = await compiler.runtime.resolveTarget(actor, { requestId: input.requestId, modelConfigId: input.modelConfigId,
      toolKey: input.toolKey, promptInput, sourceUrls: input.sourceUrls }, { adminTest: compilation.adminTest === true });
    parameters = await promptImageBackground(promptInput, target, () => compiler.runtime.readSource(actor, input.sourceUrls[0]!), parameters);
  }
  const userInput = { ...promptInput, compilationId: compilation.id };
  parameters.promptOptimization = { optimized: compilation.optimized, compilationId: compilation.id };
  if (archive) {
    const config = archive.config && typeof archive.config === "object" ? archive.config as Record<string, unknown> : {};
    parameters.inputArchive = { ...archive, prompt: promptInput.userText, effectivePrompt: compilation.prompt, config: { ...config, systemPrompt: "" }, userInput };
  }
  return { ...input, prompt: compilation.prompt, promptInput: userInput, userInput, promptCompilationId: compilation.id, optimized: compilation.optimized, parameters };
}
