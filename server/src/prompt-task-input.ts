import { promptInputSchema, requiredPromptScene, type PromptInput } from "../../shared/prompt-contracts";
import type { PromptActor, PromptCompiler } from "./prompt-compiler";
import { assertVideoMotionTimeline, PromptOptimizationError } from "./prompt-safety";
import { promptImageBackground } from "./prompt-image-background";
import { readImageAgentGenerationProfile } from "./image-agent-profile";
import { normalizeVideoMotionSettings } from "../../shared/video-motion-options";
import { assertImageEditMarkupSupport } from "./image-edit-input";

export type PromptTaskInput = {
  requestId: string; operationType: string; toolKey?: string; modelConfigId?: string | null;
  prompt: string; promptInput?: PromptInput; parameters: Record<string, unknown>; sourceUrls: string[];
};

/** Runs before queue admission/credit reservation; output contains no authoring rules. */
export async function preparePromptTaskInput<T extends PromptTaskInput>(compiler: PromptCompiler, actor: PromptActor, input: T, options: { videoSourceMimeTypes?: string[] } = {}): Promise<T & { userInput?: PromptInput; promptCompilationId?: string; summaryZh?: string; optimized: boolean }> {
  const imageAgentProfile = readImageAgentGenerationProfile(input.parameters, input.operationType);
  if (imageAgentProfile && input.promptInput) throw new PromptOptimizationError("IMAGE_AGENT_PROMPT_ALREADY_PLANNED", "图片助手已完成本轮规划，不应再次提交提示词扩写。", 400);
  const expectedScene = requiredPromptScene(input.toolKey);
  if (expectedScene && !input.promptInput) throw new PromptOptimizationError("PROMPT_INPUT_REQUIRED", "此场景必须提交表单设置并经过提示词优化，未提交生成");
  if (expectedScene && input.promptInput?.scene !== expectedScene) throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH", "优化场景与功能板块不一致，未提交生成");
  let parameters = { ...input.parameters };
  delete parameters.promptOptimization;
  if (!input.promptInput) return { ...input, parameters, optimized: false };
  if (!["image_generation", "inpaint", "batch_image", "video_generation"].includes(input.operationType)) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "此任务类型不支持提示词优化");
  if (!input.modelConfigId) throw new PromptOptimizationError("MODEL_REQUIRED", "请先选择生成模型");
  const promptInput = promptInputSchema.parse(input.promptInput);
  const isVideo = input.operationType === "video_generation";
  const expectedMode = isVideo ? "video" : input.operationType === "image_generation" ? "generate" : "edit";
  if (promptInput.mode !== expectedMode || (promptInput.scene === "video-motion") !== isVideo) throw new PromptOptimizationError("PROMPT_OPERATION_INVALID", "优化模式与实际生成操作不一致，未提交生成");
  let sourceUrls = input.sourceUrls;
  if (isVideo) {
    const mimeTypes = options.videoSourceMimeTypes;
    if (!mimeTypes || mimeTypes.length !== input.sourceUrls.length) throw new PromptOptimizationError("VIDEO_PREFLIGHT_REQUIRED", "视频素材尚未完成预检，未调用动效规划");
    const imageIndexes = mimeTypes.flatMap((mime, index) => mime.startsWith("image/") ? [index] : []);
    sourceUrls = imageIndexes.map(index => input.sourceUrls[index]!);
    const roles = promptInput.referenceRoles;
    if (roles.length && roles.length !== input.sourceUrls.length && roles.length !== imageIndexes.length) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "素材分工数量与实际素材不一致");
    const counters = { video: 0, audio: 0 };
    const mediaReferences = mimeTypes.flatMap((mime, index) => {
      const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : null;
      return kind ? [{ kind, index: ++counters[kind], role: roles.length === mimeTypes.length ? roles[index] ?? "" : "" }] : [];
    });
    promptInput.referenceRoles = roles.length === mimeTypes.length ? imageIndexes.map(index => roles[index]!) : roles;
    if (!promptInput.referenceRoles.length) promptInput.referenceRoles = imageIndexes.map((_, index) => parameters.videoMode === "first-last-frame" ? index ? "尾帧" : "首帧" : parameters.videoMode === "first-frame" ? "首帧" : "参考图片");
    promptInput.fields = { ...normalizeVideoMotionSettings(promptInput.fields), duration: parameters.seconds, ratio: parameters.size,
      resolution: parameters.resolution, video_mode: parameters.videoMode, generate_audio: parameters.generateAudio !== false, media_references: mediaReferences,
      media_source_ids: mimeTypes.flatMap((mime, index) => mime.startsWith("image/") ? [] : [input.sourceUrls[index]!]) };
    promptInput.outputLanguage = "zh";
  }
  const archive = parameters.inputArchive && typeof parameters.inputArchive === "object" ? parameters.inputArchive as Record<string, unknown> : undefined;
  const markupIndex = archive?.markupReferenceIndex;
  if (markupIndex !== undefined) {
    const target = await compiler.runtime.resolveTarget(actor, { requestId: input.requestId, modelConfigId: input.modelConfigId,
      toolKey: input.toolKey, promptInput, sourceUrls: input.sourceUrls });
    assertImageEditMarkupSupport(parameters, { ...target, operationType: input.operationType, workflow: Boolean(target.workflowConfigId) }, input.sourceUrls.length);
    // The optimizer saw ordinary references only; the independently validated overlay remains in the task archive.
    sourceUrls = input.sourceUrls.filter((_, index) => index !== markupIndex);
  }
  const archiveMask = archive?.maskReferenceIndex;
  if (archiveMask !== undefined) {
    if (typeof archiveMask !== "number" || (promptInput.maskReferenceIndex !== undefined && promptInput.maskReferenceIndex !== archiveMask)) throw new PromptOptimizationError("PROMPT_MASK_INVALID", "优化蒙版与生成蒙版索引不一致");
    promptInput.maskReferenceIndex = archiveMask;
    promptInput.hasMask = true;
  } else if (promptInput.hasMask) throw new PromptOptimizationError("PROMPT_MASK_INVALID", "生成输入缺少优化时使用的选区蒙版");
  const compilation = await compiler.compile(actor, { requestId: input.requestId, modelConfigId: input.modelConfigId,
    toolKey: input.toolKey, promptInput, sourceUrls });
  if (compilation.status !== "success" || !compilation.prompt) throw new PromptOptimizationError(compilation.errorCode || "PROMPT_OPTIMIZING",
    compilation.message || "提示词仍在优化，未提交生成，请查询原请求", compilation.status === "failed" ? 422 : 409);
  if (isVideo) assertVideoMotionTimeline(compilation.prompt, parameters.seconds);
  if (["pattern-extract", "pattern-colorway"].includes(promptInput.scene)) {
    const target = await compiler.runtime.resolveTarget(actor, { requestId: input.requestId, modelConfigId: input.modelConfigId,
      toolKey: input.toolKey, promptInput, sourceUrls: input.sourceUrls }, { adminTest: compilation.adminTest === true });
    parameters = await promptImageBackground(promptInput, target, () => compiler.runtime.readSource(actor, input.sourceUrls[0]!), parameters);
  }
  const userInput = { ...promptInput, compilationId: compilation.id };
  parameters.promptOptimization = { optimized: compilation.optimized, compilationId: compilation.id, ...(compilation.summaryZh ? { summaryZh: compilation.summaryZh } : {}) };
  if (archive) {
    const config = archive.config && typeof archive.config === "object" ? archive.config as Record<string, unknown> : {};
    parameters.inputArchive = { ...archive, prompt: promptInput.userText, effectivePrompt: compilation.prompt, config: { ...config, systemPrompt: "" }, userInput };
  }
  return { ...input, prompt: compilation.prompt, promptInput: userInput, userInput, promptCompilationId: compilation.id, ...(compilation.summaryZh ? { summaryZh: compilation.summaryZh } : {}), optimized: compilation.optimized, parameters };
}
