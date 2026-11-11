import { createHash } from "node:crypto";
import { z } from "zod";
import { carryoverRequirementsSchema } from "../../shared/design-brief";
import { promptCompilationRequestSchema, type PromptCompilationRequest, type PromptInput, type AdminPromptCompilation } from "../../shared/prompt-contracts";
import { PromptRecipeStore, promptHash } from "./prompt-recipe-store";
import { parseOptimizedPrompt, assertPromptOutputContent, assertVideoMotionTimeline, PromptOptimizationError, specifiedPromptText } from "./prompt-safety";
import { readProviderSubmissionDiagnostics } from "./provider-submission-transport";
import { prepareImageEditInput, ImageEditInputError } from "./image-edit-input";
import { isDefinitiveSubmissionRejection } from "./provider-submission-policy";
import { videoMotionLabels } from "../../shared/video-motion-options";
import { ChatProtocolError } from "./routes/chat";
import { chatUpstreamFailureReasons } from "./chat-upstream-failure";
import { promptImageReferenceLimit } from "./image-task-policy";
import { newCreativeFields, validateNewCreativeReferences } from "./new-creative-scenes";
import { imagePromptOutputContract } from "./prompt-output-contract";
import { compileSceneTemplate } from "./prompt-scene-templates";
import { assertMinimalPromptFidelity, minimalPromptPolicy, promptChainRevision, promptOutputMetrics } from "./prompt-minimal-policy";

export type PromptActor = { id: string; role: string; departmentId?: string | null; groupId?: string | null; groupRole?: string | null };
export type PromptSource = { bytes: Uint8Array; mimeType: string; previewDataUrl: string };
export type PromptTargetModel = { id: string; modelId: string; protocol: string; fingerprint: string; workflowConfigId?: string | null };
export type PromptOptimizer = { id: string; modelId: string; fingerprint: string; estimatedRmbCost: number | null;
  invoke: (system: string, content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>, context: { userId: string; compilationId: string }) => Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number; actualCost?: number; currency?: string } }>;
};
export type PromptCompilerRuntime = {
  resolveTarget(actor: PromptActor, request: PromptCompilationRequest, options?: { adminTest: boolean }): Promise<PromptTargetModel>;
  resolveOptimizer(id: string): Promise<PromptOptimizer>;
  readSource(actor: PromptActor, url: string): Promise<PromptSource>;
};
export type PromptCompileOptions = { versionId?: string; optimizerModelConfigId?: string };
const designFieldsSchema = z.object({
  targetProduct: z.string().trim().max(500).optional(),
  keepDetails: z.string().trim().max(2000).optional(),
  carryoverRequirements: carryoverRequirementsSchema.optional(),
}).passthrough();

/** Public form fields remain data. Shape adaptation does not contain recipe prose. */
export function normalizePromptFields(input: PromptInput) {
  const specific = newCreativeFields(input);
  if (specific) return specific;
  const checked = designFieldsSchema.safeParse(input.fields);
  if (!checked.success) throw new PromptOptimizationError("PROMPT_FIELDS_INVALID", "目标产品、关键特征或沿用要求格式无效或超过长度限制，未提交优化。", 400);
  const fields = structuredClone(checked.data);
  if (input.scene === "series-recipe") {
    const index = Number(fields.variantIndex ?? fields.branch_index ?? 0);
    fields.branch_index = index;
    if (Array.isArray(fields.palette)) fields.palette = fields.palette[index] ?? fields.palette[0];
    if (Array.isArray(fields.positions)) fields.positions = fields.positions[index] ?? fields.positions[0];
  }
  if (input.scene === "video-motion") {
    Object.assign(fields, videoMotionLabels(fields));
    // Non-image asset identities invalidate the cache, but only role descriptions go to the LLM.
    delete fields.media_source_ids;
  }
  return fields;
}
function sourceHash(source: PromptSource) { return createHash("sha256").update(source.bytes).digest("hex"); }
const normalInput = (input: PromptInput) => { const { compilationId: _id, ...rest } = input; return rest; };

export class PromptCompiler {
  constructor(readonly store: PromptRecipeStore, readonly runtime: PromptCompilerRuntime) {}

  async compile(actor: PromptActor, data: PromptCompilationRequest, options: PromptCompileOptions = {}): Promise<AdminPromptCompilation> {
    const request = promptCompilationRequestSchema.parse(data);
    const fields = normalizePromptFields(request.promptInput);
    validateNewCreativeReferences(request.promptInput, fields, request.sourceUrls.length);
    if ((options.versionId || options.optimizerModelConfigId) && actor.role !== "super_admin") throw new PromptOptimizationError("FORBIDDEN", "仅超级管理员可选择测试版本", 403);
    const byRequest = await this.store.byRequest(actor.id, request.requestId);
    const reused = request.promptInput.compilationId ? await this.store.getCompilation(request.promptInput.compilationId, actor.id) : null;
    if (request.promptInput.compilationId && !reused) throw new PromptOptimizationError("PROMPT_COMPILATION_NOT_FOUND", "优化记录不存在或无权访问", 404);
    const prior = reused ?? byRequest;
    if (prior && prior.recipeKey !== request.promptInput.scene) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "优化场景与原请求不同，请重新优化", 409);
    const active = await this.store.active(request.promptInput.scene, options.versionId ?? prior?.recipeVersionId);
    const adminTest = actor.role === "super_admin" && (Boolean(options.versionId) || prior?.adminTest === true);
    const target = await this.runtime.resolveTarget(actor, request, { adminTest });
    const isVideo = request.promptInput.scene === "video-motion";
    const strategy = active.version.executionStrategy ?? "llm";
    const minimal = strategy !== "llm" && !isVideo && request.promptInput.scene !== "reverse-prompt";
    const maskIndex = request.promptInput.maskReferenceIndex;
    if (request.promptInput.hasMask !== (maskIndex !== undefined) || (maskIndex !== undefined && maskIndex >= request.sourceUrls.length)) {
      throw new PromptOptimizationError("PROMPT_MASK_INVALID", "优化选区与实际蒙版不一致，请重新绘制后提交");
    }
    const referenceLimit = isVideo ? 30 : promptImageReferenceLimit(target);
    if (request.sourceUrls.length - Number(maskIndex !== undefined) > referenceLimit) throw new PromptOptimizationError("PROMPT_REFERENCE_LIMIT", `当前模型的提示词优化最多支持 ${referenceLimit} 张参考图（不含独立蒙版或标注层），未提交生成`);
    const sources: PromptSource[] = [];
    for (const url of request.sourceUrls) sources.push(await this.runtime.readSource(actor, url));
    const mask = maskIndex === undefined ? undefined : sources[maskIndex];
    if (mask && mask.mimeType !== "image/png") throw new PromptOptimizationError("PROMPT_MASK_INVALID", "选区蒙版必须为 PNG 图片");
    if (mask) {
      try { await prepareImageEditInput(sources, { inputArchive: { maskReferenceIndex: maskIndex } }, { ...target, operationType: request.promptInput.mode === "edit" ? "inpaint" : "image_generation", workflow: Boolean(target.workflowConfigId) }); }
      catch (error) { if (error instanceof ImageEditInputError) throw new PromptOptimizationError("PROMPT_MASK_INVALID", error.message); throw error; }
    }
    const references = sources.filter((_, index) => index !== maskIndex);
    const roles = request.promptInput.referenceRoles.length === sources.length && maskIndex !== undefined
      ? request.promptInput.referenceRoles.filter((_, index) => index !== maskIndex) : request.promptInput.referenceRoles;
    if (roles.length && roles.length !== references.length) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "参考图分工数量与实际图片不一致，未提交生成");
    if (request.promptInput.scene !== "text-to-style" && !["free-optimize", "batch-optimize", "video-motion"].includes(request.promptInput.scene) && !references.length) {
      throw new PromptOptimizationError("PROMPT_REFERENCE_REQUIRED", "此场景需要参考图，未提交生成");
    }
    const userText = request.promptInput.userText || (typeof fields.instruction === "string" ? fields.instruction : "");
    const requiredText = specifiedPromptText(userText, fields);
    const language = isVideo ? "zh" : request.promptInput.outputLanguage ?? active.version.outputLanguage;
    const template = strategy === "template-first" && minimal
      ? compileSceneTemplate(request.promptInput, fields, references.length, roles, language, requiredText) : undefined;
    const method = template ? "template" : minimal ? "minimal" : "llm";
    const optimizerId = options.optimizerModelConfigId ?? prior?.modelConfigId ?? active.recipe.modelConfigId;
    if (!template && !optimizerId) throw new PromptOptimizationError("PROMPT_MODEL_NOT_CONFIGURED", "此请求需要理解或创作，但管理员尚未绑定改写模型，未提交生成", 503);
    const optimizer = template ? undefined : await this.runtime.resolveOptimizer(optimizerId!);
    const modelRules = active.version.modelOverrides[target.id] ?? active.version.modelOverrides[target.modelId] ?? "";
    const system = [active.version.systemPrompt, active.version.fieldTemplate, modelRules,
      minimal ? minimalPromptPolicy : !isVideo && request.promptInput.scene !== "reverse-prompt" ? imagePromptOutputContract : ""].filter(Boolean).join("\n\n");
    const outputOptions = { video: isVideo, reverse: request.promptInput.scene === "reverse-prompt", minimal, referenceCount: references.length, userText: `${userText}\n${JSON.stringify(fields)}`, language, requiredText };
    const inputHash = promptHash({ version: active.version.id, target: target.fingerprint, optimizer: optimizer?.fingerprint ?? `server-template:${promptChainRevision}`, adminTest,
      ...(minimal ? { strategy, engineRevision: promptChainRevision } : {}),
      input: { ...normalInput(request.promptInput), outputLanguage: language }, references: references.map((source, index) => ({ hash: sourceHash(source), role: roles[index] ?? "" })),
      mask: mask ? sourceHash(mask) : null });
    const checkedResult = (result: AdminPromptCompilation) => {
      // Stored success is not a bypass, including older unvalidated fallbacks.
      if (result.status === "success") {
        assertPromptOutputContent(result.prompt ?? "", [system], outputOptions);
        if (method === "minimal") assertMinimalPromptFidelity(result.prompt ?? "", outputOptions.userText, result.questions);
        if (isVideo) assertVideoMotionTimeline(result.prompt ?? "", fields.duration);
      }
      return result;
    };
    if (prior) {
      if (prior.inputHash !== inputHash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "输入、图片或模型配置已改变，请重新优化后生成", 409);
      return checkedResult(await this.waitForResult(prior.id, actor.id));
    }
    const claim = await this.store.claim({ userId: actor.id, requestId: request.requestId, inputHash, recipeKey: active.recipe.key, recipeVersionId: active.version.id,
      details: { adminTest, modelConfigId: optimizer?.id ?? `server-template:${promptChainRevision}`, targetModelConfigId: target.id, inputSnapshot: { promptInput: request.promptInput, sourceUrls: request.sourceUrls },
        ...(minimal ? { method } : {}),
        optimized: false, rawResponse: null, latencyMs: null, inputTokens: null, outputTokens: null, actualCost: null, estimatedCost: null, currency: "CNY", completedAt: null },
    });
    if (!claim.execute) return checkedResult(await this.waitForResult(claim.id, actor.id));
    const started = performance.now();
    const payload = { recipe: active.recipe.key, target_model: target.modelId,
      model_style: isVideo ? "video" : request.promptInput.scene === "reverse-prompt" ? "natural" : /midjourney/i.test(target.modelId) ? "tags" : request.promptInput.mode === "edit" ? "edit" : "natural",
      output_language: language, mode: request.promptInput.mode, fields, user_text: userText,
      images: references.map((_, index) => ({ index: index + 1, role: roles[index] || (index === 0 ? "主体参考图" : "辅助参考图") })), has_mask: Boolean(mask) };
    const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [{ type: "input_text", text: JSON.stringify(payload) }];
    references.forEach((source, index) => content.push({ type: "input_text", text: `Image ${index + 1}` }, { type: "input_image", image_url: source.previewDataUrl }));
    if (mask) content.push({ type: "input_text", text: "编辑范围蒙版（不是编号参考图）" }, { type: "input_image", image_url: mask.previewDataUrl });
    let rawResponse: string | null = null;
    let usage: Awaited<ReturnType<PromptOptimizer["invoke"]>>["usage"];
    try {
      if (template) {
        assertPromptOutputContent(template.prompt, [system], outputOptions);
        await this.store.finish(claim.id, "success", { prompt: template.prompt, summaryZh: template.summaryZh, questions: [], optimized: false,
          promptMetrics: promptOutputMetrics(template.prompt, request.promptInput), latencyMs: Math.round(performance.now() - started),
          inputTokens: 0, outputTokens: 0, actualCost: 0, estimatedCost: null, currency: "CNY", message: "服务端固定模板，未调用改写模型。" });
        return checkedResult((await this.store.getCompilation(claim.id, actor.id))!);
      }
      const result = await optimizer!.invoke(system, content, { userId: actor.id, compilationId: claim.id });
      rawResponse = result.content;
      usage = result.usage;
      const { avoidForMetrics, ...output } = parseOptimizedPrompt(result.content, [system], outputOptions);
      if (minimal) assertMinimalPromptFidelity(output.prompt, outputOptions.userText, output.questions);
      if (isVideo) assertVideoMotionTimeline(output.prompt, fields.duration);
      await this.store.finish(claim.id, "success", { ...output, optimized: true, rawResponse, promptMetrics: promptOutputMetrics(output.prompt, request.promptInput, avoidForMetrics),
        ...(output.questions?.length ? { message: "需要先补充或确认下列信息，尚未提交图片生成。" } : {}),
        latencyMs: Math.round(performance.now() - started), ...usageFields(usage, optimizer!.estimatedRmbCost) });
    } catch (error) {
      const diagnostics = readProviderSubmissionDiagnostics(error);
      const upstreamStatus = error && typeof error === "object" && "upstreamStatus" in error ? Number(error.upstreamStatus) : undefined;
      const knownFailure = rawResponse !== null || error instanceof PromptOptimizationError || diagnostics?.phase === "initial_tls" || diagnostics?.phase === "preflight"
        || (upstreamStatus !== undefined && isDefinitiveSubmissionRejection(upstreamStatus));
      const uncertain = !knownFailure;
      const failure = error instanceof PromptOptimizationError ? error : new PromptOptimizationError(uncertain ? "PROMPT_SUBMISSION_UNCERTAIN" : "PROMPT_OPTIMIZATION_FAILED",
        uncertain ? `${isVideo ? "动效规划" : "提示词优化"}状态待核查，未提交生成；不会自动重新提交` : isVideo ? "动效规划失败，未提交生成" : "提示词优化失败，未提交生成", 502);
      const upstreamDiagnostics = error instanceof ChatProtocolError ? {
        ...(typeof error.upstreamStatus === "number" && Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
        ...(error.upstreamReason && chatUpstreamFailureReasons.includes(error.upstreamReason) ? { upstreamReason: error.upstreamReason } : {}),
      } : {};
      const metrics = { rawResponse, latencyMs: Math.round(performance.now() - started), ...usageFields(usage, rawResponse === null ? null : optimizer?.estimatedRmbCost ?? null), ...upstreamDiagnostics };
      if (!uncertain && active.recipe.failurePolicy === "fallback" && active.version.fallbackPrompt.trim() && failure.code !== "PROMPT_OUTPUT_REJECTED") {
        const prompt = active.version.fallbackPrompt.replaceAll("{{user_text}}", userText).replaceAll("{{fields}}", JSON.stringify(fields));
        try {
          const fallbackRaw = isVideo ? prompt : JSON.stringify(outputOptions.reverse ? { prompt, summary_zh: "" } : { prompt, avoid: [], keep_text: [], ...(minimal ? { summary_zh: "按管理员明确配置的基础模板执行。", questions: [] } : {}) });
          const { avoidForMetrics, ...fallback } = parseOptimizedPrompt(fallbackRaw, [system], outputOptions);
          if (minimal) assertMinimalPromptFidelity(fallback.prompt, outputOptions.userText, fallback.questions);
          if (isVideo) assertVideoMotionTimeline(fallback.prompt, fields.duration);
          await this.store.finish(claim.id, "success", { ...metrics, ...fallback, promptMetrics: promptOutputMetrics(fallback.prompt, request.promptInput, avoidForMetrics), optimized: false, message: "未优化：管理员已显式启用基础模板" });
        } catch (fallbackError) {
          const timelineFailure = fallbackError instanceof PromptOptimizationError && fallbackError.code === "PROMPT_VIDEO_TIMELINE_INVALID" ? fallbackError : null;
          await this.store.finish(claim.id, "failed", { ...metrics, errorCode: timelineFailure?.code ?? "PROMPT_OUTPUT_REJECTED", message: timelineFailure?.message ?? "备用提示词未通过检查，未提交生成" });
        }
      } else await this.store.finish(claim.id, uncertain ? "uncertain" : "failed", { ...metrics, errorCode: failure.code, message: failure.message });
    }
    return checkedResult((await this.store.getCompilation(claim.id, actor.id))!);
  }

  async waitForResult(id: string, userId: string) {
    const deadline = Date.now() + 200_000;
    for (;;) {
      const result = await this.store.getCompilation(id, userId);
      if (!result) throw new PromptOptimizationError("PROMPT_COMPILATION_NOT_FOUND", "优化记录不存在", 404);
      if (result.status !== "optimizing" || Date.now() >= deadline) return result;
      await Bun.sleep(300);
    }
  }
}
function usageFields(usage: Awaited<ReturnType<PromptOptimizer["invoke"]>>["usage"], estimate: number | null) {
  const actual = typeof usage?.actualCost === "number" && Number.isFinite(usage.actualCost) && usage.actualCost >= 0 && usage.currency ? usage.actualCost : null;
  return { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, actualCost: actual,
    estimatedCost: actual === null && estimate !== null && estimate > 0 ? estimate : null, currency: actual !== null ? usage!.currency! : "CNY" };
}
