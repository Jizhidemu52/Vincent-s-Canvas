import { createHash } from "node:crypto";
import { promptCompilationRequestSchema, type PromptCompilationRequest, type PromptInput, type AdminPromptCompilation } from "../../shared/prompt-contracts";
import { PromptRecipeStore, promptHash } from "./prompt-recipe-store";
import { parseOptimizedPrompt, assertNoPromptRuleLeak, PromptOptimizationError, specifiedPromptText } from "./prompt-safety";
import { readProviderSubmissionDiagnostics } from "./provider-submission-transport";
import { prepareImageEditInput, ImageEditInputError } from "./image-edit-input";
import { isDefinitiveSubmissionRejection } from "./provider-submission-policy";

export type PromptActor = { id: string; role: string; departmentId?: string | null; groupId?: string | null; groupRole?: string | null };
export type PromptSource = { bytes: Uint8Array; mimeType: string; previewDataUrl: string };
export type PromptTargetModel = { id: string; modelId: string; protocol: string; fingerprint: string; workflowConfigId?: string | null };
export type PromptOptimizer = { id: string; modelId: string; fingerprint: string; estimatedRmbCost: number | null;
  invoke: (system: string, content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>) => Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number; actualCost?: number; currency?: string } }>;
};
export type PromptCompilerRuntime = {
  resolveTarget(actor: PromptActor, request: PromptCompilationRequest, options?: { adminTest: boolean }): Promise<PromptTargetModel>;
  resolveOptimizer(id: string): Promise<PromptOptimizer>;
  readSource(actor: PromptActor, url: string): Promise<PromptSource>;
};
export type PromptCompileOptions = { versionId?: string; optimizerModelConfigId?: string };

/** Public form fields remain data. Shape adaptation does not contain recipe prose. */
export function normalizePromptFields(input: PromptInput) {
  const fields = structuredClone(input.fields);
  if (input.scene === "series-recipe") {
    const index = Number(fields.variantIndex ?? fields.branch_index ?? 0);
    fields.branch_index = index;
    if (Array.isArray(fields.palette)) fields.palette = fields.palette[index] ?? fields.palette[0];
    if (Array.isArray(fields.positions)) fields.positions = fields.positions[index] ?? fields.positions[0];
  }
  return fields;
}
function sourceHash(source: PromptSource) { return createHash("sha256").update(source.bytes).digest("hex"); }
const normalInput = (input: PromptInput) => { const { compilationId: _id, ...rest } = input; return rest; };

export class PromptCompiler {
  constructor(readonly store: PromptRecipeStore, readonly runtime: PromptCompilerRuntime) {}

  async compile(actor: PromptActor, data: PromptCompilationRequest, options: PromptCompileOptions = {}): Promise<AdminPromptCompilation> {
    const request = promptCompilationRequestSchema.parse(data);
    if ((options.versionId || options.optimizerModelConfigId) && actor.role !== "super_admin") throw new PromptOptimizationError("FORBIDDEN", "仅超级管理员可选择测试版本", 403);
    const byRequest = await this.store.byRequest(actor.id, request.requestId);
    const reused = request.promptInput.compilationId ? await this.store.getCompilation(request.promptInput.compilationId, actor.id) : null;
    if (request.promptInput.compilationId && !reused) throw new PromptOptimizationError("PROMPT_COMPILATION_NOT_FOUND", "优化记录不存在或无权访问", 404);
    const prior = reused ?? byRequest;
    if (prior && prior.recipeKey !== request.promptInput.scene) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "优化场景与原请求不同，请重新优化", 409);
    const active = await this.store.active(request.promptInput.scene, options.versionId ?? prior?.recipeVersionId);
    const adminTest = actor.role === "super_admin" && (Boolean(options.versionId) || prior?.adminTest === true);
    const target = await this.runtime.resolveTarget(actor, request, { adminTest });
    const optimizerId = options.optimizerModelConfigId ?? prior?.modelConfigId ?? active.recipe.modelConfigId;
    if (!optimizerId) throw new PromptOptimizationError("PROMPT_MODEL_NOT_CONFIGURED", "管理员尚未绑定此配方的扩写模型，未提交生成", 503);
    const optimizer = await this.runtime.resolveOptimizer(optimizerId);
    if (request.sourceUrls.length > 8) throw new PromptOptimizationError("PROMPT_REFERENCE_LIMIT", "提示词优化最多支持 8 张输入图片（含蒙版），未提交生成");
    const sources: PromptSource[] = [];
    for (const url of request.sourceUrls) sources.push(await this.runtime.readSource(actor, url));
    const maskIndex = request.promptInput.maskReferenceIndex;
    if (request.promptInput.hasMask !== (maskIndex !== undefined) || (maskIndex !== undefined && maskIndex >= sources.length)) {
      throw new PromptOptimizationError("PROMPT_MASK_INVALID", "优化选区与实际蒙版不一致，请重新绘制后提交");
    }
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
    if (request.promptInput.scene !== "text-to-style" && !["free-optimize", "batch-optimize"].includes(request.promptInput.scene) && !references.length) {
      throw new PromptOptimizationError("PROMPT_REFERENCE_REQUIRED", "此场景需要参考图，未提交生成");
    }
    const fields = normalizePromptFields(request.promptInput);
    const userText = request.promptInput.userText || (typeof fields.instruction === "string" ? fields.instruction : "");
    const requiredText = specifiedPromptText(userText, fields);
    const language = request.promptInput.outputLanguage ?? active.version.outputLanguage;
    const inputHash = promptHash({ version: active.version.id, target: target.fingerprint, optimizer: optimizer.fingerprint, adminTest,
      input: { ...normalInput(request.promptInput), outputLanguage: language }, references: references.map((source, index) => ({ hash: sourceHash(source), role: roles[index] ?? "" })),
      mask: mask ? sourceHash(mask) : null });
    if (prior) {
      if (prior.inputHash !== inputHash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "输入、图片或模型配置已改变，请重新优化后生成", 409);
      return this.waitForResult(prior.id, actor.id);
    }
    const claim = await this.store.claim({ userId: actor.id, requestId: request.requestId, inputHash, recipeKey: active.recipe.key, recipeVersionId: active.version.id,
      details: { adminTest, modelConfigId: optimizer.id, targetModelConfigId: target.id, inputSnapshot: { promptInput: request.promptInput, sourceUrls: request.sourceUrls },
        optimized: false, rawResponse: null, latencyMs: null, inputTokens: null, outputTokens: null, actualCost: null, estimatedCost: null, currency: "CNY", completedAt: null },
    });
    if (!claim.execute) return this.waitForResult(claim.id, actor.id);
    const started = performance.now();
    const modelRules = active.version.modelOverrides[target.id] ?? active.version.modelOverrides[target.modelId] ?? "";
    const system = [active.version.systemPrompt, active.version.fieldTemplate, modelRules].filter(Boolean).join("\n\n");
    const payload = { recipe: active.recipe.key, target_model: target.modelId,
      model_style: request.promptInput.scene === "reverse-prompt" ? "natural" : /midjourney/i.test(target.modelId) ? "tags" : request.promptInput.mode === "edit" ? "edit" : "natural",
      output_language: language, mode: request.promptInput.mode, fields, user_text: userText,
      images: references.map((_, index) => ({ index: index + 1, role: roles[index] || (index === 0 ? "主体参考图" : "辅助参考图") })), has_mask: Boolean(mask) };
    const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [{ type: "input_text", text: JSON.stringify(payload) }];
    references.forEach((source, index) => content.push({ type: "input_text", text: `Image ${index + 1}` }, { type: "input_image", image_url: source.previewDataUrl }));
    if (mask) content.push({ type: "input_text", text: "编辑范围蒙版（不是编号参考图）" }, { type: "input_image", image_url: mask.previewDataUrl });
    let rawResponse: string | null = null;
    let usage: Awaited<ReturnType<PromptOptimizer["invoke"]>>["usage"];
    try {
      const result = await optimizer.invoke(system, content);
      rawResponse = result.content;
      usage = result.usage;
      const output = parseOptimizedPrompt(result.content, [system], { reverse: request.promptInput.scene === "reverse-prompt", referenceCount: references.length, userText: `${userText}\n${JSON.stringify(fields)}`, language, requiredText });
      await this.store.finish(claim.id, "success", { ...output, optimized: true, rawResponse, latencyMs: Math.round(performance.now() - started), ...usageFields(usage, optimizer.estimatedRmbCost) });
    } catch (error) {
      const diagnostics = readProviderSubmissionDiagnostics(error);
      const upstreamStatus = error && typeof error === "object" && "upstreamStatus" in error ? Number(error.upstreamStatus) : undefined;
      const knownFailure = rawResponse !== null || error instanceof PromptOptimizationError || diagnostics?.phase === "initial_tls" || diagnostics?.phase === "preflight"
        || (upstreamStatus !== undefined && isDefinitiveSubmissionRejection(upstreamStatus));
      const uncertain = !knownFailure;
      const failure = error instanceof PromptOptimizationError ? error : new PromptOptimizationError(uncertain ? "PROMPT_SUBMISSION_UNCERTAIN" : "PROMPT_OPTIMIZATION_FAILED",
        uncertain ? "提示词优化状态待核查，未提交生图；不会自动重新提交" : "提示词优化失败，未提交生成", 502);
      const metrics = { rawResponse, latencyMs: Math.round(performance.now() - started), ...usageFields(usage, rawResponse === null ? null : optimizer.estimatedRmbCost) };
      if (!uncertain && active.recipe.failurePolicy === "fallback" && active.version.fallbackPrompt.trim() && failure.code !== "PROMPT_OUTPUT_REJECTED") {
        const prompt = active.version.fallbackPrompt.replaceAll("{{user_text}}", userText).replaceAll("{{fields}}", JSON.stringify(fields));
        try {
          assertNoPromptRuleLeak(prompt, [system]);
          if (prompt.length > 20_000) throw failure;
          await this.store.finish(claim.id, "success", { ...metrics, prompt, optimized: false, message: "未优化：管理员已显式启用基础模板" });
        } catch {
          await this.store.finish(claim.id, "failed", { ...metrics, errorCode: "PROMPT_OUTPUT_REJECTED", message: "备用提示词未通过检查，未提交生成" });
        }
      } else await this.store.finish(claim.id, uncertain ? "uncertain" : "failed", { ...metrics, errorCode: failure.code, message: failure.message });
    }
    return (await this.store.getCompilation(claim.id, actor.id))!;
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
