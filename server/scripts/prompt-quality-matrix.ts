/**
 * Explicit paid end-to-end QA through public application APIs, never provider APIs.
 * Default is an offline dry-run. Credentials are read only from PQ_COOKIE at runtime.
 * Run from server/: bun scripts/prompt-quality-matrix.ts --run-id visual-v1 [--execute]
 * Optional: --only creative,workflow --limit 2; PQ_API_BASE, PQ_MODEL_CONFIG_ID,
 * PQ_CONCURRENCY (default 4), PQ_TIMEOUT_MS (default 1200000), PQ_POLL_MS (default 3000).
 * Reuse the same run ID to resume: any previously attempted paid POST is query-only.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { creativeQualityCases, extendedCreativeQualityCases, auxiliaryQualityCases, qualityAssets, type QualityCase, type QualityAssetKey, type SceneAdapter } from "./prompt-quality-cases";
import { getToolDefinition } from "../../shared/feature-catalog";
import type { PublicPromptCompilation } from "../../shared/prompt-contracts";

type Model = { id: string; modelId: string; name?: string; enabled?: boolean; capabilities: string[]; protocol?: string; rmbCost?: number };
type Tool = { toolKey: string; modelConfigId: string | null; enabled: boolean; rmbCostOverride?: number | null };
type Task = { id: string; requestId: string; status: string; prompt?: string; optimized?: boolean; resultUrls?: string[]; rmbCost?: number; credits?: number; errorCode?: string; userId?: string };
type CaseStatus = "ready" | "running" | "success" | "failed" | "uncertain" | "blocked";
type Cost = { actualCost: number | null; estimatedCost: number | null; currency: string | null; inputTokens: number | null; outputTokens: number | null; cacheHit: boolean | null; latencyMs: number | null };
type CaseRecord = {
  id: string; requestId: string; compilationRequestId: string; inputHash: string; status: CaseStatus;
  modelConfigId?: string; modelId?: string; compileAttempted?: boolean; taskAttempted?: boolean; chatAttempted?: boolean;
  compilation?: PublicPromptCompilation; compilationCost?: Cost; tasks?: Task[]; batchId?: string;
  compilationEvidence?: { recipeKey: string; recipeVersionId: string | null; optimizerModelConfigId: string | null; targetModelConfigId: string | null };
  finalPrompt?: string; optimized?: boolean; outputs?: Array<{ taskId: string; index: number; path: string; mime: string; sha256: string; bytes: number; contentType: string | null }>;
  chat?: { content: string; toolCalls: unknown[] }; errorCode?: string;
  applicationChargeRmb?: number | null; providerImageActualCost?: null; providerChatActualCost?: null;
  visualReview: "pending-manual-review"; startedAt?: string; completedAt?: string;
};
type Ledger = {
  version: 1; runId: string; baselineCommit: string; ownerHash?: string; apiOrigin?: string;
  createdAt: string; updatedAt: string; assets: Record<string, { id: string; sha256: string; mime: string; bytes: number }>;
  models?: Model[]; tools?: Tool[]; cases: Record<string, CaseRecord>;
};
export class QualityHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const root = resolve(import.meta.dir, "../..");
const baselineCommit = "4ed9d8d";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : "UNCLASSIFIED_ERROR";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
export function sanitizePublicText(value: string): string {
  return value.replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|authorization|cookie|password)\s*[=:]\s*)[^\s,;"<>]+/gi, "$1[REDACTED]");
}
export function maySubmitPaidPost(attempted: boolean | undefined): boolean { return attempted !== true; }
export function selectCompilationCost(input: Record<string, unknown>): Cost {
  return { actualCost: number(input.actualCost), estimatedCost: number(input.estimatedCost), currency: typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : null,
    inputTokens: number(input.inputTokens), outputTokens: number(input.outputTokens), cacheHit: typeof input.cacheHit === "boolean" ? input.cacheHit : null, latencyMs: number(input.latencyMs) };
}
function publicCompilation(value: any): PublicPromptCompilation {
  return { id: String(value.id), requestId: String(value.requestId), status: value.status, optimized: value.optimized === true,
    ...(typeof value.prompt === "string" ? { prompt: sanitizePublicText(value.prompt) } : {}), ...(typeof value.summaryZh === "string" ? { summaryZh: sanitizePublicText(value.summaryZh) } : {}),
    ...(value.errorCode ? { errorCode: safeCode(value.errorCode) } : {}) };
}
function publicTask(value: any): Task {
  return { id: String(value.id), requestId: String(value.requestId), status: String(value.status), ...(typeof value.prompt === "string" ? { prompt: sanitizePublicText(value.prompt) } : {}),
    ...(typeof value.optimized === "boolean" ? { optimized: value.optimized } : {}), resultUrls: Array.isArray(value.resultUrls) ? value.resultUrls.filter((url: unknown) => typeof url === "string") : [],
    ...(number(value.rmbCost) !== null ? { rmbCost: value.rmbCost } : {}), ...(number(value.credits) !== null ? { credits: value.credits } : {}), ...(value.errorCode ? { errorCode: safeCode(value.errorCode) } : {}) };
}
export async function loadBaselineBuilder(repoRoot = root) {
  const process = Bun.spawn(["git", "show", `${baselineCommit}:web/src/pages/creative/scene-form-model.ts`], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const source = await new Response(process.stdout).text();
  if (await process.exited !== 0) throw new Error("BASELINE_GIT_OBJECT_MISSING");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  if (/^import\s/m.test(javascript)) throw new Error("BASELINE_HAS_RUNTIME_IMPORTS");
  const module = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  if (typeof module.buildScenePrompt !== "function") throw new Error("BASELINE_BUILDER_MISSING");
  return { build: module.buildScenePrompt as (scene: string, form: any) => string, sourceSha256: sha(source) };
}
export async function loadCurrentSceneAdapter(repoRoot = root): Promise<SceneAdapter> {
  const source = await readFile(resolve(repoRoot, "web/src/pages/creative/scene-form-model.ts"), "utf8");
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  if (/^import\s/m.test(javascript)) throw new Error("CURRENT_SCENE_HAS_RUNTIME_IMPORTS");
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}
function selectCases(cases: QualityCase[], args: string[]) {
  const at = args.indexOf("--only"), selected = at >= 0 ? args[at + 1]?.split(",").filter(Boolean) : undefined;
  const found = selected ? cases.filter(item => selected.some(prefix => item.group === prefix || item.id.startsWith(prefix))) : cases;
  const limitIndex = args.indexOf("--limit");
  if (limitIndex < 0) return found;
  const limit = Number(args[limitIndex + 1]);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_LIMIT");
  return found.slice(0, limit);
}
function selectedModel(item: QualityCase, models: Model[], tools: Tool[], fallback: string): Model {
  const tool = tools.find(tool => tool.toolKey === item.toolKey);
  if (!tool || !tool.enabled) throw new Error("TOOL_DISABLED_OR_MISSING");
  const id = tool.modelConfigId || item.requestedModelId || fallback;
  if (item.requestedModelId && id !== item.requestedModelId) throw new Error("BOUND_MODEL_DIFFERS");
  const model = models.find(model => model.id === id);
  if (!model || model.enabled === false) throw new Error("MODEL_DISABLED_OR_MISSING");
  return model;
}
export function protocolQualityCases(models: Model[], tools: Tool[], primaryId: string): QualityCase[] {
  return models.filter(model => model.enabled !== false && model.id !== primaryId && model.capabilities.some(capability => capability === "generate" || capability === "edit")).map(model => {
    const displayIdentity = `${model.name || ""} ${model.modelId}`.toLowerCase();
    if (/mj-blend|midjourney-blend/.test(displayIdentity)) return {
      id: `protocol-${model.id}`, group: "protocol", label: `协议烟测 ${model.name || model.modelId}`, requestedModelId: model.id,
      toolKey: "midjourney-blend", sources: ["shirt", "flat"], prompt: "", operationType: "image_generation", parameters: { size: "1:1", n: 1, speed: "fast" },
      checks: ["双图 Blend 协议提交、结果取回与真实 MIME", "Blend 不接受文字提示词，不调用扩写模型", "单例烟测不能代表视觉质量"],
    } as QualityCase;
    const edit = model.capabilities.includes("edit");
    const candidates = edit ? ["image-edit", "canvas-edit"] : ["image", "canvas-image"];
    const tool = tools.find(tool => candidates.includes(tool.toolKey) && tool.enabled && (!tool.modelConfigId || tool.modelConfigId === model.id));
    return { id: `protocol-${model.id}`, group: "protocol", label: `协议烟测 ${model.modelId}`, requestedModelId: model.id, toolKey: tool?.toolKey || candidates[0]!, sources: edit ? ["shirt"] : [],
      ...(/nano|gemini/.test(displayIdentity) ? { parameters: { n: 1, size: "1:1", resolution: "1K" } } : {}),
      prompt: edit ? "仅将衬衫大身改为鼠尾草绿色，保留其余内容。" : "奶油色圆领短袖T恤，白底平铺，无口袋。", input: { scene: "free-optimize", fields: {}, userText: edit ? "仅将衬衫大身改为鼠尾草绿色，保留其余内容。" : "奶油色圆领短袖T恤，白底平铺，无口袋。", referenceRoles: edit ? ["参考图1"] : [], mode: edit ? "edit" : "generate" }, checks: ["协议提交、结果取回、原始 MIME", "绑定模型不一致时阻止调用，不擅自更改管理员配置", "单例协议烟测不能代表模型视觉质量"] };
  });
}

export async function runQualityMatrix(args = process.argv.slice(2)) {
  const runIndex = args.indexOf("--run-id");
  const runId = runIndex < 0 ? "visual-v1" : args[runIndex + 1] || "";
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(runId)) throw new Error("INVALID_RUN_ID");
  const output = resolve(root, "output/prompt-optimization/quality-matrix", runId);
  if (!output.startsWith(resolve(root, "output/prompt-optimization/quality-matrix") + sep)) throw new Error("INVALID_OUTPUT_PATH");
  await mkdir(output, { recursive: true });
  const baseline = await loadBaselineBuilder();
  const extended = args.includes("--extended-scenes");
  let matrix = extended ? extendedCreativeQualityCases(baseline.build, await loadCurrentSceneAdapter())
    : [...creativeQualityCases(baseline.build, await loadCurrentSceneAdapter()), ...auxiliaryQualityCases()];
  if (matrix.some(item => !getToolDefinition(item.toolKey))) throw new Error("CASE_TOOL_KEY_INVALID");
  const plan = { version: 1, runId, baselineCommit, baselineSourceSha256: baseline.sourceSha256, baselineAssumptions: ["旧版提示词取自 Git 4ed9d8d 的真实 buildScenePrompt 加旧参考编号前缀", "无自定义全局 systemPrompt；与新版使用相同素材字节和实际图像模型", "只有调用参数控制对照；随机生图不承诺相同随机种子"],
    visualReview: "pending-manual-review", privateRulesIncluded: false, assetFixtures: qualityAssets, cases: selectCases(matrix, args),
    plannedFullMatrix: { records: matrix.length, images: extended ? 40 : 220, compilations: extended ? 20 : 127, chatResponses: extended ? 0 : 4, extraProtocolSmoke: "运行时枚举其他启用图片模型；不能合法选择的模型报告 blocked" },
    limits: ["真实 UI 按钮、复制、历史导出、刷新恢复与完整串行工作流需单独浏览器验收", "没有真实 mask 样本，不代表严格蒙版验收", "视觉评分必须人工按 checks 核对，HTTP 成功不记视觉通过", "图像实际上游费用若 API 未提供则未知，应用配置扣费不是账单"] };
  await writeFile(resolve(output, "plan.json"), JSON.stringify(plan, null, 2));
  if (!args.includes("--execute")) {
    console.log(JSON.stringify({ mode: "dry-run", networkRequests: 0, paidRequests: 0, selectedCases: plan.cases.length, plan: relative(root, resolve(output, "plan.json")) }));
    return plan;
  }
  const base = new URL(process.env.PQ_API_BASE || "http://127.0.0.1:3100");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/") throw new Error("INVALID_API_ORIGIN");
  const cookie = process.env.PQ_COOKIE || "";
  const concurrency = Number(process.env.PQ_CONCURRENCY || 4), timeoutMs = Number(process.env.PQ_TIMEOUT_MS || 1_200_000), pollMs = Number(process.env.PQ_POLL_MS || 3000);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || !Number.isFinite(pollMs) || pollMs < 100) throw new Error("INVALID_QA_OPTIONS");
  const lockPath = resolve(output, ".run.lock");
  const lock = await open(lockPath, "wx").catch(() => { throw new Error("RUN_LOCK_EXISTS_CHECK_PRIOR_PROCESS_BEFORE_REMOVING"); });
  await lock.writeFile(JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }));
  let ledger: Ledger;
  const statePath = resolve(output, "ledger.json");
  let saveQueue = Promise.resolve();
  let ownerId = "";
  let allCases = matrix;
  const persist = () => {
    ledger.updatedAt = new Date().toISOString();
    // Provider result query strings can be signed credentials. Re-query tasks on resume.
    const json = JSON.stringify(ledger, (key, value) => key === "resultUrls" ? undefined : value, 2);
    saveQueue = saveQueue.then(async () => { await writeFile(`${statePath}.tmp`, json); await rename(`${statePath}.tmp`, statePath); });
    return saveQueue;
  };
  const headers = () => ({ ...(cookie ? { cookie } : {}), ...(ownerId ? { "x-canvas-owner-id": ownerId } : {}) });
  const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error("CROSS_ORIGIN_AUTH_BLOCKED");
    const response = await fetch(url, { method, redirect: "error", headers: { ...headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.min(timeoutMs, 240_000)) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new QualityHttpError(response.status, safeCode(result.error ?? result.code));
    return result.data && typeof result.data === "object" && "code" in result ? result.data : result;
  };
  const maybe = async (path: string) => { try { return await api(path); } catch (error) { if (error instanceof QualityHttpError && error.status === 404) return null; throw error; } };
  const assets = new Map<QualityAssetKey, Promise<string>>();
  const upload = (key: QualityAssetKey): Promise<string> => {
    if (assets.has(key)) return assets.get(key)!;
    const promise = (async () => {
      const bytes = await readFile(resolve(root, qualityAssets[key].path));
      const type = await fileTypeFromBuffer(bytes); if (!type?.mime.startsWith("image/")) throw new Error("FIXTURE_MIME_INVALID");
      const hash = sha(bytes), existing = ledger.assets[key];
      if (existing && existing.sha256 !== hash) throw new Error("FIXTURE_CHANGED_NEW_RUN_REQUIRED");
      if (existing) return `/api/assets/${existing.id}/content`;
      const created = await api("/api/assets/upload-request", "POST", { filename: basename(qualityAssets[key].path), mimeType: type.mime, byteSize: bytes.byteLength, kind: "image", clientReferenceId: `qa-${hash}`, metadata: { contentSha256: hash, source: "prompt-quality-matrix" } });
      if (created.uploadUrl) {
        const url = new URL(created.uploadUrl, base); if (url.origin !== base.origin) throw new Error("CROSS_ORIGIN_UPLOAD_BLOCKED");
        const response = await fetch(url, { method: "PUT", redirect: "error", headers: { ...headers(), "content-type": type.mime }, body: bytes, signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new QualityHttpError(response.status, "FIXTURE_UPLOAD_FAILED");
      }
      ledger.assets[key] = { id: created.assetId, sha256: hash, mime: type.mime, bytes: bytes.byteLength }; await persist();
      return `/api/assets/${created.assetId}/content`;
    })();
    assets.set(key, promise); return promise;
  };
  const compilationAccounting = async (item: QualityCase, record: CaseRecord) => {
    if (!item.input || !record.compilation?.id) return;
    try {
      const response = await api(`/api/admin/prompt-recipes/${item.input.scene}/compilations/${record.compilation.id}`), value = response.compilation || response;
      record.compilationCost = selectCompilationCost(value);
      const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value) ? value : null;
      record.compilationEvidence = { recipeKey: item.input.scene, recipeVersionId: id(value.recipeVersionId), optimizerModelConfigId: id(value.modelConfigId), targetModelConfigId: id(value.targetModelConfigId) };
    }
    catch { record.compilationCost = selectCompilationCost({}); }
  };
  const compile = async (item: QualityCase, record: CaseRecord, sourceUrls: string[]) => {
    if (!item.input) return;
    if (record.compilation?.status !== "success") {
      let response: any;
      if (maySubmitPaidPost(record.compileAttempted)) {
        record.compileAttempted = true; await persist();
        try { response = await api("/api/prompt-compilations", "POST", { requestId: record.compilationRequestId, modelConfigId: record.modelConfigId, toolKey: item.toolKey, promptInput: item.input, sourceUrls: item.kind === "batch" ? sourceUrls.slice(0, 1) : sourceUrls }); }
        catch (error) { response = await maybe(`/api/prompt-compilations/by-request/${encodeURIComponent(record.compilationRequestId)}`); if (!response) throw error; }
      } else response = await maybe(`/api/prompt-compilations/by-request/${encodeURIComponent(record.compilationRequestId)}`);
      if (!response?.compilation) throw new Error("COMPILATION_UNKNOWN_NO_RESUBMIT");
      record.compilation = publicCompilation(response.compilation); await persist();
      if (record.compilation.status !== "success") throw new Error(record.compilation.status === "failed" ? record.compilation.errorCode || "COMPILATION_FAILED" : "COMPILATION_UNCERTAIN_NO_RESUBMIT");
    }
    record.finalPrompt = record.compilation.prompt; record.optimized = record.compilation.optimized;
    await compilationAccounting(item, record); await persist();
  };
  const downloadResults = async (record: CaseRecord) => {
    record.outputs ||= [];
    for (const task of record.tasks || []) for (const [index, result] of (task.resultUrls || []).entries()) {
      if (record.outputs.some(output => output.taskId === task.id && output.index === index)) continue;
      const url = new URL(result, base);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("RESULT_URL_PROTOCOL_UNSUPPORTED");
      // Never forward application credentials to a provider/CDN result URL.
      const response = await fetch(url, { headers: url.origin === base.origin ? headers() : {}, redirect: url.origin === base.origin ? "error" : "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new QualityHttpError(response.status, "RESULT_DOWNLOAD_FAILED");
      const bytes = new Uint8Array(await response.arrayBuffer()), type = await fileTypeFromBuffer(bytes);
      if (!type?.mime.startsWith("image/")) throw new Error("RESULT_NOT_IMAGE");
      const filename = `${record.id}-${task.id}-${index + 1}.${type.ext}`;
      await writeFile(resolve(output, filename), bytes);
      record.outputs.push({ taskId: task.id, index, path: filename, mime: type.mime, sha256: sha(bytes), bytes: bytes.length, contentType: response.headers.get("content-type") }); await persist();
    }
  };
  const runImages = async (item: QualityCase, record: CaseRecord, sourceUrls: string[]) => {
    const batch = item.kind === "batch", query = batch ? `/api/tasks/batches/by-request/${encodeURIComponent(record.requestId)}` : `/api/tasks/by-request/${encodeURIComponent(record.requestId)}`;
    let submitted: any;
    if (maySubmitPaidPost(record.taskAttempted)) {
      record.taskAttempted = true; await persist();
      const parameters = { ...(item.parameters || { n: 1, size: "1024x1024", quality: "auto" }), tool: item.toolKey };
      const body = { requestId: record.requestId, projectId: "prompt-quality-assurance", toolKey: item.toolKey, operationType: batch ? "batch_image" : item.operationType || (sourceUrls.length ? "inpaint" : "image_generation"), modelConfigId: record.modelConfigId,
        prompt: record.finalPrompt || item.prompt, ...(item.input ? { promptInput: { ...item.input, compilationId: record.compilation!.id } } : {}), parameters, priority: "normal", ...(batch ? { items: sourceUrls.map(url => ({ sourceUrls: [url] })) } : { sourceUrls }) };
      try { submitted = await api(batch ? "/api/tasks/batch" : "/api/tasks", "POST", body); }
      catch (error) { submitted = await maybe(query); if (!submitted) throw error; }
    } else submitted = await maybe(query);
    if (!submitted || (batch && submitted.submissionComplete === false)) throw new Error("TASK_SUBMISSION_UNKNOWN_NO_RESUBMIT");
    if (batch) { record.batchId = submitted.batchId; record.tasks = (submitted.tasks || []).map(publicTask); if ((submitted.failures || []).length) record.errorCode = "PARTIAL_BATCH_FAILURE"; }
    else record.tasks = submitted.task ? [publicTask(submitted.task)] : [];
    if (record.tasks!.length !== (batch ? sourceUrls.length : 1)) throw new Error("TASK_COUNT_MISMATCH_NO_RESUBMIT");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      record.tasks = await Promise.all(record.tasks!.map(async task => publicTask((await api(`/api/tasks/${task.id}`)).task)));
      record.finalPrompt = record.tasks[0]?.prompt || record.finalPrompt || item.prompt; record.optimized = record.tasks[0]?.optimized ?? record.optimized ?? false;
      record.applicationChargeRmb = record.tasks.every(task => typeof task.rmbCost === "number") ? record.tasks.reduce((sum, task) => sum + task.rmbCost!, 0) : null;
      await persist();
      if (record.tasks.every(task => ["success", "failed", "cancelled", "paused"].includes(task.status))) break;
      if (Date.now() >= deadline) throw new Error("TASK_POLL_TIMEOUT_NO_RESUBMIT");
      await Bun.sleep(pollMs);
    }
    await downloadResults(record);
    if (record.tasks.some(task => task.status !== "success")) throw new Error(record.tasks.some(task => task.status === "paused") ? "TASK_PAUSED_NO_RESUBMIT" : "TASK_FAILED");
    if (record.outputs?.length !== record.tasks.length) throw new Error("RESULT_COUNT_MISMATCH");
  };
  const runChat = async (item: QualityCase, record: CaseRecord) => {
    if (!maySubmitPaidPost(record.chatAttempted)) { if (record.chat) return; throw new Error("CHAT_UNKNOWN_NO_RESUBMIT"); }
    // Inline bytes match the production chat image adapter; only fixtures are sent.
    const images = await Promise.all(item.sources.map(async key => { const bytes = await readFile(resolve(root, qualityAssets[key].path)); const type = await fileTypeFromBuffer(bytes); return { type: "input_image", image_url: `data:${type!.mime};base64,${bytes.toString("base64")}` }; }));
    const profileContext = item.profile === "creative-chat" ? { phase: "after-inspection", currentUserText: item.prompt, catalogTotal: 1, recentImageId: "qa-image-1", imageCatalog: [{ image_id: "qa-image-1", name: "衬衫参考图" }], workingImageDetails: [{ image_id: "qa-image-1", available: true }], previewImageIds: ["qa-image-1"] }
      : { stage: "plan", userText: item.prompt, snapshot: { nodes: [{ id: "qa-image-1", type: "image", title: "衬衫参考图" }], selectedNodeIds: ["qa-image-1"] }, references: [{ nodeId: "qa-image-1", title: "本轮图片1" }], settings: { imageCount: 1 } };
    record.chatAttempted = true; await persist();
    const result = await api("/api/chat/responses", "POST", { requestId: record.requestId, modelId: record.modelConfigId, toolKey: item.toolKey, profile: item.profile, profileContext, input: [{ role: "user", content: [{ type: "input_text", text: `本轮图片1，image_id/referenceNodeId=qa-image-1。\n${item.prompt}` }, ...images] }], tools: [], claude: { thinking: false, stream: false, maxTokens: 4096 } });
    const response = result.result || result;
    record.chat = { content: sanitizePublicText(typeof response.content === "string" ? response.content : ""), toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.map((call: any) => ({ id: call.id, type: call.type, function: { name: call.function?.name, arguments: sanitizePublicText(String(call.function?.arguments || "")) } })) : [] };
    await persist();
  };
  const writeReport = async () => {
    const records = Object.values(ledger.cases);
    const report = { runId, baselineCommit, apiOrigin: base.origin, counts: Object.fromEntries(["ready", "running", "success", "failed", "uncertain", "blocked"].map(status => [status, records.filter(record => record.status === status).length])),
      paidPostAttempts: { compilation: records.filter(record => record.compileAttempted).length, taskOrBatch: records.filter(record => record.taskAttempted).length, chat: records.filter(record => record.chatAttempted).length },
      costs: { optimizer: records.map(record => ({ caseId: record.id, ...(record.compilationCost || selectCompilationCost({})) })), applicationConfiguredChargeRmb: records.filter(record => record.applicationChargeRmb != null).reduce((sum, record) => sum + record.applicationChargeRmb!, 0), imageProviderActualCost: null, chatProviderActualCost: null, note: "null means unavailable, not free; configured application charge is not upstream billing" },
      visualReview: "pending-manual-review", cases: records.map(record => ({ ...record, tasks: record.tasks?.map(({ resultUrls: _privateUrls, ...task }) => task) })) };
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    const rows = records.map(record => { const item = allCases.find(item => item.id === record.id); return `<section><h2>${escapeHtml(item?.label || record.id)}</h2><p>${record.status} / 视觉待核 / ${escapeHtml(record.errorCode || "")}</p><div class="images">${(record.outputs || []).map(image => `<figure><img loading="lazy" src="${encodeURIComponent(image.path)}"><figcaption>${escapeHtml(image.mime)} / ${image.bytes} bytes</figcaption></figure>`).join("")}</div><details><summary>输入、最终提示词、验收点</summary><pre>${escapeHtml(JSON.stringify({ requestId: record.requestId, userInput: item?.input || item?.prompt, finalPrompt: record.finalPrompt, chat: record.chat, checks: item?.checks }, null, 2))}</pre></details></section>`; }).join("\n");
    await writeFile(resolve(output, "review.html"), `<!doctype html><meta charset="utf-8"><title>Prompt QA ${escapeHtml(runId)}</title><style>body{font:15px system-ui;margin:24px;background:#eee;color:#222}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}section{background:white;padding:16px}h2{font-size:17px}.images{display:flex;gap:8px}figure{margin:0;max-width:100%}img{max-width:100%;max-height:560px}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}</style><h1>${escapeHtml(runId)} — HTTP 成功不等于视觉验收通过</h1><p>原始字节图像；全部视觉状态待人工按验收点核对。旧新版相邻。详情不含私有配方或凭据。</p><main>${rows}</main>`);
  };
  try {
    let previous: Ledger | undefined;
    try { previous = JSON.parse(await readFile(statePath, "utf8")); } catch (error: any) { if (error.code !== "ENOENT") throw new Error("LEDGER_INVALID_DO_NOT_RECREATE"); }
    ledger = previous || { version: 1, runId, baselineCommit, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assets: {}, cases: {} };
    if (ledger.runId !== runId || ledger.version !== 1 || ledger.baselineCommit !== baselineCommit) throw new Error("LEDGER_IDENTITY_MISMATCH");
    const session = await api("/api/auth/session"); ownerId = session.user?.id; if (!ownerId) throw new Error("SESSION_OWNER_MISSING");
    if (ledger.ownerHash && ledger.ownerHash !== sha(ownerId)) throw new Error("LEDGER_OWNER_CHANGED");
    if (ledger.apiOrigin && ledger.apiOrigin !== base.origin) throw new Error("LEDGER_API_CHANGED");
    ledger.ownerHash = sha(ownerId); ledger.apiOrigin = base.origin;
    const configuration = await api("/api/models");
    const models: Model[] = configuration.models.map((model: Model) => ({ id: model.id, modelId: model.modelId, name: model.name, enabled: model.enabled, capabilities: model.capabilities, protocol: model.protocol, rmbCost: model.rmbCost }));
    const tools: Tool[] = configuration.tools.map((tool: Tool) => ({ toolKey: tool.toolKey, modelConfigId: tool.modelConfigId, enabled: tool.enabled, rmbCostOverride: tool.rmbCostOverride }));
    ledger.models = models; ledger.tools = tools;
    const primaryId = process.env.PQ_MODEL_CONFIG_ID || tools.find(tool => tool.toolKey === "creative-text-to-style")?.modelConfigId || tools.find(tool => tool.toolKey === "image")?.modelConfigId || models.find(model => model.capabilities.includes("generate"))?.id;
    if (!primaryId) throw new Error("PRIMARY_IMAGE_MODEL_MISSING");
    matrix.push(...protocolQualityCases(models, tools, primaryId)); allCases = matrix;
    matrix = selectCases(matrix, args);
    for (const item of matrix) {
      const inputHash = sha(JSON.stringify(item)); const prior = ledger.cases[item.id];
      if (prior && prior.inputHash !== inputHash) throw new Error("CASE_CHANGED_NEW_RUN_REQUIRED");
      ledger.cases[item.id] ||= { id: item.id, requestId: `pq:${runId}:${item.id}:0`, compilationRequestId: `pq:${runId}:${item.id}:compile`, inputHash, status: "ready", visualReview: "pending-manual-review", providerImageActualCost: null, providerChatActualCost: null };
    }
    await persist();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, matrix.length) }, async () => {
      while (index < matrix.length) {
        const item = matrix[index++]!, record = ledger.cases[item.id]!;
        if (["success", "failed"].includes(record.status)) continue;
        try {
          const model = selectedModel(item, models, tools, item.requestedModelId || primaryId);
          if (record.modelConfigId && record.modelConfigId !== model.id) throw new Error("MODEL_CHANGED_NEW_RUN_REQUIRED");
          if (item.pairId) {
            const pair = allCases.filter(candidate => candidate.pairId === item.pairId);
            if (pair.some(candidate => selectedModel(candidate, models, tools, primaryId).id !== model.id)) throw new Error("PAIR_MODEL_MISMATCH");
          }
          record.modelConfigId = model.id; record.modelId = model.modelId; record.status = "running"; record.startedAt ||= new Date().toISOString(); delete record.errorCode; await persist();
          if (item.kind === "chat") await runChat(item, record);
          else { const sourceUrls = await Promise.all(item.sources.map(upload)); await compile(item, record, sourceUrls); if (item.kind !== "compile-only") await runImages(item, record, sourceUrls); }
          record.status = "success"; record.completedAt = new Date().toISOString();
        } catch (error) {
          const code = error instanceof QualityHttpError ? error.code : error instanceof Error ? safeCode(error.message) : "UNCLASSIFIED_ERROR";
          record.errorCode = code;
          const attempted = record.compileAttempted || record.taskAttempted || record.chatAttempted;
          record.status = !attempted ? "blocked" : /(?:UNKNOWN|UNCERTAIN|TIMEOUT|PAUSED|NO_RESUBMIT)/.test(code) || !(error instanceof QualityHttpError) && code === "UNCLASSIFIED_ERROR" || error instanceof QualityHttpError && error.status >= 500 ? "uncertain" : "failed";
        }
        await persist(); await writeReport();
        console.log(JSON.stringify({ case: item.id, status: record.status, code: record.errorCode, images: record.outputs?.length || 0, visualReview: record.visualReview }));
      }
    }));
    await writeReport();
    console.log(JSON.stringify({ mode: "executed", report: relative(root, resolve(output, "report.json")), review: relative(root, resolve(output, "review.html")), visualReview: "pending-manual-review" }));
    return ledger;
  } finally { await saveQueue; await lock.close(); await unlink(lockPath); }
}

if (import.meta.main) await runQualityMatrix();
