/** Offline by default. Paid writes require BOTH config approval and --execute. No provider credentials are read. */
import { readFile, mkdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { EvalLedger, executeAttempt, sha256, canonical, costOf, codeOf, type Attempt } from "./prompt-chain-eval/ledger";
import { starterConfig, buildJobs, namespaceJobs, namespaceAttemptKey, type Config, type Job, type Source } from "./prompt-chain-eval/cases";
import { INITIAL_BATCH_ID, parseBatchApprovalArguments, validateBatchId, validateBudgetAuthorization, type BudgetAuthorization } from "./prompt-chain-eval/budget-extension";
import { preflightApiMartImageRequest } from "../server/src/apimart-image";

export const repoRoot = resolve(import.meta.dir, "..");
export const campaignDirectory = resolve(repoRoot, "output/prompt-chain-optimization/evaluation");
// Deliberately not configurable by run ID, config, environment or CLI.
export const budgetPath = resolve(campaignDirectory, "budget.sqlite");
const requireServer = createRequire(resolve(repoRoot, "server/package.json"));
const imageType = async (bytes: Uint8Array) => (await import(pathToFileURL(requireServer.resolve("file-type")).href)).fileTypeFromBuffer(bytes);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const parameterKeys = new Set(["n", "size", "quality", "resolution", "background", "output_format", "seed"]);
export function validateImageParameters(parameters: Record<string, unknown>) {
  if (parameters.n !== 1 || Object.keys(parameters).some(key => !parameterKeys.has(key)) || Object.values(parameters).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) throw new Error("ONLY_ONE_IMAGE_PARAMETERS_ALLOWED");
}
function compilationCacheEvidence(value: any) {
  const hasFlag = Object.hasOwn(value, "cacheHit"), hasSource = Object.hasOwn(value, "reusedFromId");
  const flag = typeof value.cacheHit === "boolean" ? value.cacheHit : null;
  const source = value.reusedFromId === null ? false : typeof value.reusedFromId === "string" && uuid.test(value.reusedFromId) ? true : null;
  if ((hasFlag && flag === null) || (hasSource && source === null) || (hasFlag && hasSource && flag !== source))
    return { cacheHit: null, cacheEvidence: "invalid-or-conflicting" };
  return { cacheHit: hasFlag ? flag : hasSource ? source : null, cacheEvidence: hasFlag && hasSource ? "cacheHit+reusedFromId" : hasFlag ? "cacheHit" : hasSource ? "reusedFromId" : "unknown" };
}
export function validateOrigin(value: string) {
  const base = new URL(value);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("INVALID_API_ORIGIN");
  return base;
}
async function saveNew(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(typeof value === "string" ? value : JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
}
function sourcePath(source: Source) {
  const path = resolve(repoRoot, source.path);
  if (isAbsolute(source.path) || !path.startsWith(repoRoot + sep)) throw new Error("SOURCE_OUTSIDE_REPOSITORY");
  return path;
}
export async function sourceEvidence(source: Source) {
  const path = sourcePath(source), bytes = await readFile(path), type = await imageType(bytes);
  if (!type?.mime.startsWith("image/")) throw new Error("SOURCE_NOT_IMAGE");
  return { ...source, sha256: sha256(bytes), bytes: bytes.length, mime: type.mime };
}

export class ApplicationClient {
  readonly base: URL;
  ownerId = "";
  constructor(origin: string, private readonly cookie = process.env.PCE_COOKIE || "", private readonly fetcher: (url: string | URL | Request, init: RequestInit) => Promise<Response> = fetch) { this.base = validateOrigin(origin); }
  headers() { return { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.ownerId ? { "x-canvas-owner-id": this.ownerId } : {}) }; }
  async api(path: string, method = "GET", body?: unknown): Promise<any> {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin) throw new Error("CROSS_ORIGIN_AUTH_BLOCKED");
    const response = await this.fetcher(url, { method, redirect: "error", headers: { ...this.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240_000) });
    const value = await response.json().catch(() => ({})) as any;
    if (!response.ok) { if (response.status === 404) throw new Error("HTTP_NOT_FOUND"); throw new Error(`HTTP_${response.status}`); }
    return value.data && typeof value.data === "object" && "code" in value ? value.data : value;
  }
  async maybe(path: string) { try { return await this.api(path); } catch (error) { if (codeOf(error) === "HTTP_NOT_FOUND") return null; throw error; } }
  async bytes(urlOrPath: string, method = "GET", bytes?: Uint8Array, mime?: string) {
    const url = new URL(urlOrPath, this.base), sameOrigin = url.origin === this.base.origin;
    if (!["http:", "https:"].includes(url.protocol) || (method !== "GET" && !sameOrigin)) throw new Error("CROSS_ORIGIN_UPLOAD_BLOCKED");
    const response = await this.fetcher(url, { method, redirect: "error", headers: { ...(sameOrigin ? this.headers() : {}), ...(mime ? { "content-type": mime } : {}) }, body: bytes ? new Uint8Array(bytes).buffer : undefined, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error("MEDIA_REQUEST_FAILED");
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
  }
}

export async function preflight(config: Config, jobs: Job[], client: ApplicationClient, ledger: EvalLedger) {
  validateImageParameters(config.parameters);
  if (!config.approvedForPaidExecution) throw new Error("CONFIG_NOT_APPROVED_FOR_PAID_EXECUTION");
  const session = await client.api("/api/auth/session");
  if (!session.user?.id) throw new Error("SESSION_OWNER_MISSING");
  client.ownerId = session.user.id;
  ledger.bind({ apiOrigin: client.base.origin, ownerHash: sha256(client.ownerId) });
  const pendingJobs = jobs.filter(job => !ledger.get(job.key));
  if (!pendingJobs.length) return; // Existing attempts are query-only, regardless of catalog/config drift.
  if (session.user.role !== "super_admin") throw new Error("ISOLATED_ADMIN_TEST_SESSION_REQUIRED");
  const catalog = await client.api("/api/models");
  // Public modelId may intentionally be the configuration UUID (including for administrators).
  // The protected configuration endpoint exposes m.model_id as modelId without credentials.
  const configuredModels = await client.api("/api/admin/model-configuration/models");
  const versions = new Map<string, any>();
  for (const job of pendingJobs) {
    if (!uuid.test(job.model.modelConfigId)) throw new Error("MODEL_CONFIGURATION_REQUIRED");
    const model = catalog.models?.find((model: any) => model.id === job.model.modelConfigId);
    const configured = configuredModels.models?.find((model: any) => model.id === job.model.modelConfigId);
    if (!model || model.enabled === false || !model.capabilities?.includes("edit") || !configured
      || configured.enabled !== true || configured.providerEnabled !== true || configured.modelId !== job.model.expectedModelId
      || !configured.capabilities?.includes("edit")) throw new Error("MODEL_IDENTITY_OR_EDIT_CAPABILITY_MISMATCH");
    if (configured.protocol === "apimart" && !configured.workflowConfigId) {
      try {
        // Same pure adapter validation used before provider uploads; these URLs are never fetched.
        // main() validates every new job here before prepare(), reservation, asset writes or compilation.
        preflightApiMartImageRequest({ modelId: configured.modelId, prompt: job.sample.userText, parameters: config.parameters,
          sourceImages: job.sample.sources.map((_, index) => `https://owned-reference.invalid/source-${index + 1}.png`) });
      } catch (cause) { throw new Error("APIMART_IMAGE_PREFLIGHT_FAILED", { cause }); }
    }
    if (job.sample.sources.some(source => !source.approvedForEvaluation)) throw new Error("SOURCE_APPROVAL_REQUIRED");
    for (const source of job.sample.sources.filter(source => !source.fromAttempt)) await sourceEvidence(source);
    const toolKey = job.strategy === "raw" ? "image-edit" : `creative-${job.sample.scene}`;
    const tool = catalog.tools?.find((tool: any) => tool.toolKey === toolKey);
    if (!tool?.enabled) throw new Error("TOOL_DISABLED_OR_MISSING");
    if (job.strategy === "raw" && tool.modelConfigId && tool.modelConfigId !== job.model.modelConfigId) throw new Error("RAW_TOOL_BOUND_TO_DIFFERENT_MODEL");
    if (job.strategy !== "raw") {
      const recipe = config.recipes[job.sample.scene]?.[job.strategy];
      if (!recipe || !uuid.test(recipe.versionId)) throw new Error("EXPLICIT_RECIPE_VERSION_REQUIRED");
      if (!versions.has(job.sample.scene)) versions.set(job.sample.scene, await client.api(`/api/admin/prompt-recipes/${job.sample.scene}`));
      const version = versions.get(job.sample.scene).versions?.find((version: any) => version.id === recipe.versionId);
      if (!version || (version.executionStrategy ?? "llm") !== recipe.expectedExecutionStrategy) throw new Error("RECIPE_STRATEGY_MISMATCH");
    }
  }
}

export class EvaluationTransport {
  private uploaded = new Map<string, Promise<string>>();
  constructor(readonly config: Config, readonly client: ApplicationClient, readonly ledger: EvalLedger, readonly output = campaignDirectory) {}
  async upload(source: Awaited<ReturnType<typeof sourceEvidence>>) {
    if (!this.uploaded.has(source.sha256)) this.uploaded.set(source.sha256, (async () => {
      const bytes = new Uint8Array(await readFile(sourcePath(source)));
      if (sha256(bytes) !== source.sha256) throw new Error("SOURCE_CHANGED_BEFORE_UPLOAD");
      const result = await this.client.api("/api/assets/upload-request", "POST", { filename: source.path.split(/[\\/]/).pop(), mimeType: source.mime, byteSize: bytes.length, kind: "image",
        clientReferenceId: `pce-${source.sha256}`, metadata: { contentSha256: source.sha256, source: "prompt-chain-eval" } });
      if (result.uploadUrl) await this.client.bytes(result.uploadUrl, "PUT", bytes, source.mime);
      if (typeof result.assetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(result.assetId)) throw new Error("ASSET_ID_MISSING");
      return `/api/assets/${result.assetId}/content`;
    })());
    return this.uploaded.get(source.sha256)!;
  }
  async prepare(job: Job) {
    const sources = [];
    for (const source of job.sample.sources) {
      let resolved = source;
      if (source.fromAttempt) {
        const previous = this.ledger.get(source.fromAttempt), result = previous?.evidence.outputs?.[0];
        if (previous?.status !== "success" || !result?.path) throw new Error("SEQUENCE_PREVIOUS_RESULT_NOT_READY");
        resolved = { ...source, path: result.path };
        const evidence = await sourceEvidence(resolved);
        if (evidence.sha256 !== result.sha256) throw new Error("SEQUENCE_RESULT_CHANGED");
        sources.push(evidence);
      } else sources.push(await sourceEvidence(source));
    }
    const recipe = job.strategy === "raw" ? null : this.config.recipes[job.sample.scene]?.[job.strategy];
    return { ...job, parameters: this.config.parameters, recipe: recipe ?? null, sources,
      visualReview: { status: "pending-manual-review", change: job.sample.change, preserve: job.sample.preserve } };
  }
  async submit(attempt: Attempt) {
    const input = attempt.input;
    validateImageParameters(input.parameters);
    const sourceUrls = await Promise.all(input.sources.map((source: any) => this.upload(source)));
    const toolKey = input.strategy === "raw" ? "image-edit" : `creative-${input.sample.scene}`;
    let prompt = input.sample.userText, promptInput: any;
    if (input.strategy !== "raw") {
      promptInput = { scene: input.sample.scene, fields: input.sample.fields, userText: input.sample.userText, referenceRoles: input.sources.map((s: any) => s.role), mode: "edit", outputLanguage: "zh" };
      this.ledger.mark(attempt.key, "running", { planningCost: costOf(), sourceAssetPaths: sourceUrls }, { planningStarted: true });
      let response;
      try { response = await this.client.api(`/api/admin/prompt-recipes/${input.sample.scene}/test`, "POST", { requestId: attempt.compilationRequestId, modelConfigId: input.model.modelConfigId,
        toolKey, sourceUrls, promptInput, versionId: input.recipe.versionId, ...(input.recipe.optimizerModelConfigId ? { optimizerModelConfigId: input.recipe.optimizerModelConfigId } : {}) }); }
      catch { response = await this.client.maybe(`/api/prompt-compilations/by-request/${encodeURIComponent(attempt.compilationRequestId)}`); }
      const compilation = response?.compilation;
      if (!compilation) throw new Error("COMPILATION_UNKNOWN_NO_RESUBMIT");
      const method = await this.recordCompilation(attempt, compilation);
      if (compilation.status !== "success" || compilation.questions?.length || !compilation.prompt) {
        this.ledger.mark(attempt.key, compilation.status === "failed" || compilation.questions?.length ? "failed" : "uncertain", { errorCode: compilation.questions?.length ? "COMPILATION_QUESTIONS_BLOCK_GENERATION" : "COMPILATION_NOT_SUCCESSFUL" });
        return;
      }
      const allowedMethods = input.strategy === "template" ? ["template", "minimal"] : input.strategy === "minimal" ? ["minimal"] : ["llm"];
      if (!allowedMethods.includes(method ?? "")) {
        this.ledger.mark(attempt.key, "failed", { errorCode: "COMPILATION_METHOD_MISMATCH" });
        return;
      }
      prompt = compilation.prompt;
      promptInput.compilationId = compilation.id;
    }
    this.ledger.mark(attempt.key, "running", { finalPrompt: prompt, actualMethod: input.strategy === "raw" ? "raw" : this.ledger.get(attempt.key)!.evidence.actualMethod,
      sourceAssetPaths: sourceUrls, imageCost: costOf(), imageSubmittedAt: new Date().toISOString() }, { imagePostStarted: true });
    try {
      await this.client.api("/api/tasks", "POST", { requestId: attempt.requestId, projectId: "prompt-chain-evaluation", operationType: "inpaint", toolKey,
        modelConfigId: input.model.modelConfigId, prompt, ...(promptInput ? { promptInput } : {}), parameters: { ...input.parameters, tool: toolKey }, sourceUrls, priority: "normal" });
    } catch { /* The original request is queried below; a failed POST is never repeated. */ }
    const deadline = Date.now() + 1_200_000;
    do {
      await this.query(this.ledger.get(attempt.key)!);
      if (this.ledger.get(attempt.key)!.status !== "running") break;
      if (Date.now() >= deadline) { this.ledger.mark(attempt.key, "uncertain", { errorCode: "TASK_OBSERVATION_TIMEOUT_NO_RESUBMIT" }); break; }
      await Bun.sleep(3000);
    } while (true);
  }
  async recordCompilation(attempt: Attempt, compilation: any) {
    let cost = costOf(), sourcePlanningCost = costOf(), recipeEvidence: any = { recipeVersionId: attempt.input.recipe?.versionId ?? null, cacheHit: null, cacheEvidence: "unknown" };
    let method: string | null = typeof compilation.method === "string" ? compilation.method : null;
    let methodEvidence = method === null ? "unknown" : "public-method";
    try {
      const details = await this.client.api(`/api/admin/prompt-recipes/${attempt.input.sample.scene}/compilations/${compilation.id}`), value = details.compilation ?? details;
      sourcePlanningCost = costOf(value);
      recipeEvidence = { recipeVersionId: value.recipeVersionId ?? null, optimizerModelConfigId: value.modelConfigId ?? null, targetModelConfigId: value.targetModelConfigId ?? null,
        latencyMs: value.latencyMs ?? null, ...compilationCacheEvidence(value), reusedFromId: value.reusedFromId === null || typeof value.reusedFromId === "string" && uuid.test(value.reusedFromId) ? value.reusedFromId : null };
      if (recipeEvidence.recipeVersionId !== attempt.input.recipe.versionId || recipeEvidence.targetModelConfigId !== attempt.input.model.modelConfigId) throw new Error("COMPILATION_IDENTITY_MISMATCH");
      // present() reuses the original details, including its cost, on cache hits.
      cost = recipeEvidence.cacheHit === true ? costOf({ actualCost: 0, currency: sourcePlanningCost.currency }) : recipeEvidence.cacheHit === false ? sourcePlanningCost : costOf();
      const expectedOptimizer = attempt.input.recipe.optimizerModelConfigId;
      // Immutable legacy LLM versions predate method storage. Never infer from absence alone,
      // from fallback output, or for template/minimal. Require the exact tested identities.
      if (compilation.method === undefined && value.method === undefined && attempt.input.strategy === "legacy" && attempt.input.recipe.expectedExecutionStrategy === "llm"
        && typeof expectedOptimizer === "string" && expectedOptimizer.length > 0 && value.modelConfigId === expectedOptimizer
        && value.id === compilation.id && value.requestId === attempt.compilationRequestId && compilation.requestId === attempt.compilationRequestId
        && compilation.status === "success" && compilation.optimized === true && value.status === "success" && value.optimized === true) {
        method = "llm";
        methodEvidence = "legacy-admin-details";
      }
    } catch (error) { if (codeOf(error) === "COMPILATION_IDENTITY_MISMATCH") throw error; }
    this.ledger.mark(attempt.key, "running", { compilationId: compilation.id, compilationStatus: compilation.status, finalPrompt: compilation.prompt ?? null,
      actualMethod: method, methodEvidence, questions: compilation.questions ?? [], planningCost: cost, sourcePlanningCost, recipeEvidence,
      planningModelCalled: method === "template" || recipeEvidence.cacheHit === true ? false : method !== null && ["minimal", "llm"].includes(method) && recipeEvidence.cacheHit === false ? true : null });
    return method;
  }
  async query(attempt: Attempt) {
    if (attempt.planningStarted && !attempt.evidence.compilationId) {
      const result = await this.client.maybe(`/api/prompt-compilations/by-request/${encodeURIComponent(attempt.compilationRequestId)}`);
      if (result?.compilation) await this.recordCompilation(attempt, result.compilation);
    }
    // This method has no POST/PUT path, including a 404 or a crash before submission.
    const found = await this.client.maybe(`/api/tasks/by-request/${encodeURIComponent(attempt.requestId)}`), task = found?.task;
    if (!task) { this.ledger.mark(attempt.key, "uncertain", { errorCode: "ORIGINAL_TASK_NOT_FOUND_NO_RESUBMIT", elapsedMs: Date.now() - Date.parse(attempt.createdAt) }); return; }
    if (task.requestId !== attempt.requestId || (task.modelConfigId && task.modelConfigId !== attempt.input.model.modelConfigId)) throw new Error("TASK_IDENTITY_MISMATCH");
    const status = task.status === "success" ? "success" : ["failed", "cancelled"].includes(task.status) ? "failed" : task.status === "paused" ? "uncertain" : "running";
    const patch: Record<string, unknown> = { taskId: task.id, taskStatus: task.status, elapsedMs: Date.now() - Date.parse(attempt.createdAt),
      applicationChargeRmb: typeof task.rmbCost === "number" ? task.rmbCost : null, imageCost: costOf(), finalPrompt: task.prompt ?? attempt.evidence.finalPrompt ?? null,
      actualModelConfigId: task.modelConfigId ?? null,
      reportedParameters: task.parameters ? Object.fromEntries(Object.entries(task.parameters).filter(([key]) => parameterKeys.has(key))) : null,
      taskStartedAt: typeof task.startedAt === "string" ? task.startedAt : null, taskCompletedAt: typeof task.completedAt === "string" ? task.completedAt : null,
      taskDurationMs: Number.isFinite(Date.parse(task.completedAt) - Date.parse(task.startedAt)) ? Date.parse(task.completedAt) - Date.parse(task.startedAt) : null };
    if (status === "success") {
      if (!Array.isArray(task.resultUrls) || task.resultUrls.length !== 1) throw new Error("RESULT_COUNT_MISMATCH");
      const result = await this.client.bytes(task.resultUrls[0]), type = await imageType(result.bytes);
      if (!type?.mime.startsWith("image/")) throw new Error("RESULT_NOT_IMAGE");
      const hash = sha256(result.bytes), path = resolve(this.output, "results", `${attempt.requestId.replace(/:/g, "-")}-${hash}.${type.ext}`);
      await mkdir(dirname(path), { recursive: true });
      if (existsSync(path)) { if (sha256(await readFile(path)) !== hash) throw new Error("EXISTING_RESULT_CHANGED"); }
      else { const file = await open(path, "wx", 0o600); try { await file.writeFile(result.bytes); await file.sync(); } finally { await file.close(); } }
      patch.outputs = [{ path: relative(repoRoot, path).replaceAll("\\", "/"), sha256: hash, bytes: result.bytes.length, mime: type.mime, contentType: result.contentType }];
      patch.visualReview = "pending-manual-review";
    }
    this.ledger.mark(attempt.key, status, patch);
  }
}

async function exportReport(ledger: EvalLedger) {
  const path = resolve(campaignDirectory, "reports", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
  await saveNew(path, ledger.report());
  return relative(repoRoot, path);
}
function argument(args: string[], name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
export function selectedBatchArgument(args: string[]) {
  const positions = args.flatMap((arg, index) => arg === "--batch-id" ? [index] : []);
  if (!positions.length) return INITIAL_BATCH_ID;
  const value = args[positions[0]! + 1];
  if (positions.length !== 1 || !value || value.startsWith("--")) throw new Error("EXPLICIT_BATCH_ID_REQUIRED");
  if (value !== INITIAL_BATCH_ID) validateBatchId(value);
  return value;
}
export function validateRunBatch(ledger: EvalLedger, config: Config, jobs: Job[], batchId: string) {
  const batch = ledger.batch(batchId);
  if (canonical(batch.allocation) !== canonical(config.allocation)) throw new Error("CONFIG_BATCH_ALLOCATION_MISMATCH");
  const needed = { single: 0, sequence: 0, reserve: 0 };
  for (const job of jobs) {
    const prior = ledger.get(job.key);
    if (prior && prior.batchId !== batchId) throw new Error("ATTEMPT_BATCH_MISMATCH");
    if (!prior) needed[job.group]++;
  }
  if (Object.keys(needed).some(group => needed[group as keyof typeof needed] > batch.remaining[group as keyof typeof needed])) throw new Error("SELECTED_JOBS_EXCEED_REMAINING_BATCH");
}
function validateArguments(args: string[], command: string) {
  const values = command === "run" ? ["--config", "--batch-id", "--only", "--limit", "--retry-of", "--retry-key"]
    : command === "plan" || command === "recover" ? ["--config", "--batch-id"] : ["--config"];
  const flags = command === "run" ? ["--execute"] : [];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const name = args[index]!;
    if (seen.has(name) || !values.includes(name) && !flags.includes(name)) throw new Error("INVALID_COMMAND_ARGUMENTS");
    seen.add(name);
    if (values.includes(name) && (!args[++index] || args[index]!.startsWith("--"))) throw new Error("INVALID_COMMAND_ARGUMENTS");
  }
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "plan";
  if (command === "authorize-batch") {
    const parsed = parseBatchApprovalArguments(args);
    const authorization = JSON.parse(await readFile(resolve(repoRoot, parsed.authorizationFile), "utf8")) as BudgetAuthorization;
    validateBudgetAuthorization(authorization);
    // Authorization extends this existing campaign only; never bootstrap a fresh ledger here.
    if (!existsSync(budgetPath)) throw new Error("EXISTING_BUDGET_REQUIRED");
    const ledger = new EvalLedger(budgetPath);
    try { return { mode: "budget-approval-only", paidRequests: 0, ...ledger.authorizeBatch(authorization, parsed.approval) }; }
    finally { ledger.close(); }
  }
  if (!["plan", "status", "run", "recover"].includes(command)) throw new Error("UNKNOWN_COMMAND");
  validateArguments(args, command);
  if (command === "run" && !args.includes("--execute")) throw new Error("EXECUTE_FLAG_REQUIRED");
  const batchId = selectedBatchArgument(args);
  const configFile = resolve(repoRoot, argument(args, "--config") ?? "output/prompt-chain-optimization/evaluation/config.json");
  const config: Config = existsSync(configFile) ? JSON.parse(await readFile(configFile, "utf8")) : starterConfig();
  if (command === "plan") {
    const jobs = namespaceJobs(buildJobs(config, batchId === INITIAL_BATCH_ID ? 100 : Number.MAX_SAFE_INTEGER), batchId);
    if (!existsSync(configFile)) await saveNew(configFile, config);
    const candidates = await Promise.all(config.samples.map(async sample => ({ ...sample, sources: await Promise.all(sample.sources.map(sourceEvidence)) })));
    const path = resolve(campaignDirectory, "plans", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
    await saveNew(path, { offline: true, networkRequests: 0, paidRequests: 0, initialImageLimit: 100, batchId, requestedBatchImageLimit: Object.values(config.allocation).reduce((a, b) => a + b, 0),
      budgetApproval: "not-checked-offline-plan-does-not-authorize", allocation: config.allocation, candidates, jobs,
      reserve: `${config.allocation.reserve} slots are not automatically submitted. An explicit --retry-key creates a new charged reserve attempt.`, caveat: "候选是已有公开 Synthetic 业务任务素材，不代表真实公司样本；须逐组核准来源。" });
    return { mode: "offline-plan", batchId, plannedSingle: jobs.filter(j => j.group === "single").length, plannedSequence: jobs.filter(j => j.group === "sequence").length, reserve: config.allocation.reserve, paidRequests: 0, config: relative(repoRoot, configFile), plan: relative(repoRoot, path) };
  }
  if ((command === "status" || command === "recover") && !existsSync(budgetPath)) return { reservedImageAttempts: 0, message: "No budget ledger exists; nothing has been submitted." };
  if (batchId !== INITIAL_BATCH_ID && !existsSync(budgetPath)) throw new Error("EXISTING_BUDGET_REQUIRED");
  const ledger = new EvalLedger(budgetPath, command === "run" && batchId === INITIAL_BATCH_ID ? config.allocation : undefined);
  try {
    if (command === "status") { const report = ledger.report(); return { initialImageLimit: report.initialImageLimit, authorizedImageLimit: report.authorizedImageLimit, batches: report.batches,
      reservedImageAttempts: report.reservedImageAttempts, imagePostAttempts: report.imagePostAttempts, planningAttempts: report.planningAttempts, images: report.images, planning: report.planning, report: await exportReport(ledger) }; }
    const client = new ApplicationClient(config.apiOrigin), transport = new EvaluationTransport(config, client, ledger);
    if (command === "recover") {
      if (args.includes("--batch-id")) ledger.batch(batchId);
      const selected = args.includes("--batch-id") ? ledger.list().filter(attempt => attempt.batchId === batchId) : ledger.list();
      const session = await client.api("/api/auth/session"); if (!session.user?.id) throw new Error("SESSION_OWNER_MISSING");
      client.ownerId = session.user.id; ledger.bind({ apiOrigin: client.base.origin, ownerHash: sha256(client.ownerId) });
      for (const attempt of selected) try { await transport.query(attempt); } catch (error) { ledger.mark(attempt.key, "uncertain", { errorCode: codeOf(error) }); }
    } else {
      const batch = ledger.batch(batchId);
      const jobs = namespaceJobs(buildJobs(config, batch.imageLimit), batchId);
      let selected = jobs;
      const only = argument(args, "--only"); if (only) selected = selected.filter(job => job.key.includes(only));
      const limit = argument(args, "--limit"); if (limit) { if (!/^\d+$/.test(limit) || Number(limit) < 1) throw new Error("INVALID_LIMIT"); selected = selected.slice(0, Number(limit)); }
      const retryOf = argument(args, "--retry-of"), retryKey = argument(args, "--retry-key");
      if (retryOf || retryKey) {
        if (!retryOf || !retryKey || !ledger.get(retryOf)) throw new Error("EXPLICIT_RETRY_REFERENCE_REQUIRED");
        const original = jobs.find(job => job.key === retryOf) ?? ledger.get(retryOf)!.input as Job;
        selected = [{ ...original, key: namespaceAttemptKey(retryKey, batchId), group: "reserve", retryOf }];
      }
      if (!selected.length) throw new Error("NO_SELECTED_JOBS");
      validateRunBatch(ledger, config, selected, batchId);
      await preflight(config, selected, client, ledger);
      for (const job of selected) {
        const prior = ledger.get(job.key);
        if (prior) { try { await transport.query(prior); } catch (error) { ledger.mark(job.key, "uncertain", { errorCode: codeOf(error) }); } }
        else { const input = await transport.prepare(job); await executeAttempt(ledger, job.key, job.group, input, transport, batchId); }
      }
    }
    const report = ledger.report();
    return { initialImageLimit: report.initialImageLimit, authorizedImageLimit: report.authorizedImageLimit, batches: report.batches,
      reservedImageAttempts: report.reservedImageAttempts, imagePostAttempts: report.imagePostAttempts, planningAttempts: report.planningAttempts, report: await exportReport(ledger) };
  } finally { ledger.close(); }
}
if (import.meta.main) main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(JSON.stringify({ error: codeOf(error) })); process.exitCode = 1; });
