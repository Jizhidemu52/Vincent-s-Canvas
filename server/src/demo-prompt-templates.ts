import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { DemoStorageError } from "./demo-state-store";
import { presentPublicModel, isSelectableCreativeModel } from "./model-presentation";
import { isAuxiliaryImageResult } from "./image-result-variants";
import { operationForPromptTool, pricePromptModel, promptSnapshotSchema, PromptTemplateError, quantityFromParameters, resolvePromptModel, type PromptModelCandidate, type PromptSnapshot } from "./prompt-templates";
import { getToolDefinition, resolveToolKey } from "../../shared/feature-catalog";
import type { ToolConfiguration } from "./tool-configuration";

export type DemoPromptActor = { id: string; role: string; departmentId?: string | null };
type SourceAsset = { id: string; ownerUserId: string; mimeType: string; bytes: Uint8Array; taskId?: string; metadata?: Record<string, unknown>; createdAt: string };
type SourceTask = { id: string; ownerUserId: string; status: string; operationType: string; prompt?: string; parameters?: Record<string, unknown>; modelConfigId?: string };
export type DemoPromptContext = {
  models: readonly Record<string, unknown>[];
  providers: readonly Record<string, unknown>[];
  prices: readonly Record<string, unknown>[];
  tools: readonly Record<string, unknown>[];
  creditsEnabled: boolean;
  moduleEnabled?: (toolKey: string) => boolean;
  asset: (id: string) => SourceAsset | undefined;
  task: (id: string) => SourceTask | undefined;
  assets: () => readonly SourceAsset[];
};
type TemplateRow = { id: string; owner_user_id: string; department_id: string | null; current_version_id: string; favorite: number; use_count: number; last_used_at: string | null; created_at: string; updated_at: string };
type VersionRow = { id: string; template_id: string; version: number; fields_json: string };
type UsageRow = { template_id: string; version_id: string; mode: string; pricing_json: string };
type ReuseRow = UsageRow & { expires_at: number };
type SavedSnapshot = PromptSnapshot & { modelSnapshot: ReturnType<typeof presentPublicModel> | Record<string, never> };

const listSchema = z.object({
  scope: z.enum(["personal", "team", "public"]).default("personal"), query: z.string().trim().max(200).default(""),
  category: z.string().trim().max(80).optional(), tag: z.string().trim().max(40).optional(),
  favorite: z.enum(["true", "false"]).optional(), sort: z.enum(["updated", "recent", "used"]).default("updated"),
  page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
const reuseSchema = z.object({ requestId: z.string().trim().min(8).max(160), mode: z.enum(["fill", "fill_and_generate"]).default("fill") });
const favoriteSchema = z.object({ favorite: z.boolean() });
const tokenLifetimeMs = 600_000;

/** Personal templates only. Synchronous SQLite transactions never submit a model request. */
export class DemoPromptTemplateStore {
  private readonly db: Database;
  constructor(path: string, private readonly clock: () => number = Date.now) {
    let database: Database | undefined;
    try {
      if (!path.trim()) throw new Error("必须指定本地数据库路径");
      if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
      database = new Database(path, { create: true, strict: true });
      const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
      if (path !== ":memory:" && journal?.journal_mode.toLowerCase() !== "wal") throw new Error("无法启用 SQLite WAL 日志");
      database.exec(`PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS demo_prompt_templates (
          id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, department_id TEXT,
          current_version_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),
          favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)), use_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS demo_prompt_owner_idx ON demo_prompt_templates(owner_user_id,deleted,updated_at DESC);
        CREATE TABLE IF NOT EXISTS demo_prompt_versions (
          id TEXT PRIMARY KEY NOT NULL, template_id TEXT NOT NULL, version INTEGER NOT NULL,
          fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), UNIQUE(template_id,version)
        );
        CREATE TABLE IF NOT EXISTS demo_prompt_usage_requests (
          owner_user_id TEXT NOT NULL, request_id TEXT NOT NULL, template_id TEXT NOT NULL,
          version_id TEXT NOT NULL, mode TEXT NOT NULL, pricing_json TEXT NOT NULL CHECK(json_valid(pricing_json)),
          PRIMARY KEY(owner_user_id,request_id)
        );
        CREATE TABLE IF NOT EXISTS demo_prompt_reuse_tokens (
          token_hash TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL, template_id TEXT NOT NULL,
          version_id TEXT NOT NULL, mode TEXT NOT NULL, pricing_json TEXT NOT NULL CHECK(json_valid(pricing_json)), expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS demo_prompt_reuse_expiry_idx ON demo_prompt_reuse_tokens(expires_at);`);
      this.db = database;
    } catch (error) { database?.close(); throw new DemoStorageError("打开个人提示词数据库", error); }
  }

  list(actor: DemoPromptActor, query: unknown) {
    const input = listSchema.parse(query);
    if (input.scope !== "personal") return { templates: [], total: 0, page: input.page, pageSize: input.pageSize };
    return this.access("读取个人提示词", () => {
      const where = ["t.owner_user_id=?", "t.deleted=0"], args: (string | number)[] = [actor.id];
      if (input.query) { where.push("instr(lower(json_extract(v.fields_json,'$.title') || ' ' || json_extract(v.fields_json,'$.prompt') || ' ' || json_extract(v.fields_json,'$.category')),lower(?))>0"); args.push(input.query); }
      if (input.category !== undefined) { where.push("json_extract(v.fields_json,'$.category')=?"); args.push(input.category); }
      if (input.tag !== undefined) { where.push("EXISTS(SELECT 1 FROM json_each(v.fields_json,'$.tags') tag WHERE tag.value=?)"); args.push(input.tag); }
      if (input.favorite !== undefined) { where.push("t.favorite=?"); args.push(input.favorite === "true" ? 1 : 0); }
      const from = `FROM demo_prompt_templates t JOIN demo_prompt_versions v ON v.id=t.current_version_id WHERE ${where.join(" AND ")}`;
      const total = this.db.query<{ total: number }, (string | number)[]>(`SELECT count(*) AS total ${from}`).get(...args)!.total;
      const order = input.sort === "recent" ? "t.last_used_at DESC,t.updated_at DESC" : input.sort === "used" ? "t.use_count DESC,t.updated_at DESC" : "t.updated_at DESC";
      const rows = this.db.query<TemplateRow & { version: number; fields_json: string }, (string | number)[]>(`SELECT t.*,v.version,v.fields_json ${from} ORDER BY ${order},t.id DESC LIMIT ? OFFSET ?`).all(...args, input.pageSize, (input.page - 1) * input.pageSize);
      return { templates: rows.map(row => this.envelope(row, { id: row.current_version_id, template_id: row.id, version: row.version, fields_json: row.fields_json })), total, page: input.page, pageSize: input.pageSize };
    });
  }

  get(actor: DemoPromptActor, id: string, versionId?: string) {
    return this.access("读取提示词版本", () => {
      const row = this.row(actor.id, id);
      const version = this.db.query<VersionRow, [string, string]>("SELECT * FROM demo_prompt_versions WHERE id=? AND template_id=?").get(versionId || row.current_version_id, id);
      if (!version) throw notFound();
      return this.envelope(row, version);
    });
  }

  create(actor: DemoPromptActor, body: unknown, context: DemoPromptContext) {
    const snapshot = this.snapshot(actor, body, context);
    return this.access("保存个人提示词", () => this.db.transaction(() => {
      const id = randomUUID(), versionId = randomUUID(), now = this.now();
      this.db.query("INSERT INTO demo_prompt_templates(id,owner_user_id,department_id,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, actor.id, actor.departmentId || null, versionId, now, now);
      this.db.query("INSERT INTO demo_prompt_versions(id,template_id,version,fields_json) VALUES(?,?,1,?)").run(versionId, id, JSON.stringify(snapshot));
      return this.get(actor, id);
    }).immediate());
  }

  update(actor: DemoPromptActor, id: string, body: unknown, context: DemoPromptContext) {
    this.get(actor, id);
    const snapshot = this.snapshot(actor, body, context);
    return this.access("更新个人提示词", () => this.db.transaction(() => {
      this.row(actor.id, id);
      const current = this.db.query<{ version: number }, [string]>("SELECT coalesce(max(version),0) AS version FROM demo_prompt_versions WHERE template_id=?").get(id)!;
      const versionId = randomUUID();
      this.db.query("INSERT INTO demo_prompt_versions(id,template_id,version,fields_json) VALUES(?,?,?,?)").run(versionId, id, current.version + 1, JSON.stringify(snapshot));
      this.db.query("UPDATE demo_prompt_templates SET current_version_id=?,updated_at=? WHERE id=? AND owner_user_id=?").run(versionId, this.now(), id, actor.id);
      return this.get(actor, id);
    }).immediate());
  }

  copy(actor: DemoPromptActor, id: string, context: DemoPromptContext) {
    const current = this.get(actor, id);
    return this.create(actor, { ...current, title: `${current.title.slice(0, 117)} 副本` }, context);
  }

  remove(actor: DemoPromptActor, id: string) {
    this.access("删除个人提示词", () => this.db.transaction(() => {
      this.row(actor.id, id);
      this.db.query("UPDATE demo_prompt_templates SET deleted=1,updated_at=? WHERE id=? AND owner_user_id=?").run(this.now(), id, actor.id);
    }).immediate());
  }

  favorite(actor: DemoPromptActor, id: string, body: unknown) {
    const input = favoriteSchema.parse(body);
    return this.access("收藏个人提示词", () => this.db.transaction(() => {
      this.row(actor.id, id);
      this.db.query("UPDATE demo_prompt_templates SET favorite=? WHERE id=? AND owner_user_id=?").run(input.favorite ? 1 : 0, id, actor.id);
      return input;
    }).immediate());
  }

  resolve(actor: DemoPromptActor, id: string, body: unknown, context: DemoPromptContext) {
    const input = reuseSchema.parse(body);
    return this.access("创建提示词复用链接", () => this.db.transaction(() => {
      const current = this.get(actor, id);
      const previous = this.db.query<UsageRow, [string, string]>("SELECT * FROM demo_prompt_usage_requests WHERE owner_user_id=? AND request_id=?").get(actor.id, input.requestId);
      if (previous && (previous.template_id !== id || previous.mode !== input.mode)) throw new PromptTemplateError("REQUEST_ID_CONFLICT", "该复用请求标识已用于其他模板或模式", 409);
      const pricing = previous ? JSON.parse(previous.pricing_json) as ReturnType<typeof resolveDemoPromptPricing> : resolveDemoPromptPricing(actor, current, context);
      const versionId = previous?.version_id || current.currentVersionId;
      if (!previous) {
        this.db.query("INSERT INTO demo_prompt_usage_requests(owner_user_id,request_id,template_id,version_id,mode,pricing_json) VALUES(?,?,?,?,?,?)").run(actor.id, input.requestId, id, versionId, input.mode, JSON.stringify(pricing));
        this.db.query("UPDATE demo_prompt_templates SET use_count=use_count+1,last_used_at=? WHERE id=? AND owner_user_id=?").run(this.now(), id, actor.id);
      }
      const token = randomBytes(32).toString("base64url");
      this.db.query("DELETE FROM demo_prompt_reuse_tokens WHERE expires_at<=?").run(this.clock());
      this.db.query("INSERT INTO demo_prompt_reuse_tokens(token_hash,owner_user_id,template_id,version_id,mode,pricing_json,expires_at) VALUES(?,?,?,?,?,?,?)").run(hashToken(token), actor.id, id, versionId, input.mode, JSON.stringify(pricing), this.clock() + tokenLifetimeMs);
      return { reuseToken: token, expiresInSeconds: tokenLifetimeMs / 1000, mode: input.mode, pricing };
    }).immediate());
  }

  reuse(actor: DemoPromptActor, token: string, context: DemoPromptContext) {
    return this.access("读取提示词复用链接", () => {
      const row = this.db.query<ReuseRow, [string, string, number]>("SELECT * FROM demo_prompt_reuse_tokens WHERE token_hash=? AND owner_user_id=? AND expires_at>?").get(hashToken(token), actor.id, this.clock());
      if (!row) throw new PromptTemplateError("REUSE_TOKEN_INVALID", "复用链接已失效，请重新点击模板", 404);
      const template = this.get(actor, row.template_id, row.version_id);
      const accessible = template.referenceAssetIds.filter(id => ownedAsset(context, actor.id, id));
      return { template: { ...template, referenceAssetIds: accessible }, mode: row.mode, pricing: JSON.parse(row.pricing_json), warnings: accessible.length === template.referenceAssetIds.length ? [] : ["部分参考图已删除或当前无权访问"] };
    });
  }

  fromTask(actor: DemoPromptActor, id: string, context: DemoPromptContext) {
    const task = context.task(id);
    if (!task || task.ownerUserId !== actor.id || task.status !== "success") throw notFound();
    if (!task.prompt?.trim()) throw new PromptTemplateError("PROMPT_UNAVAILABLE", "该任务没有可保存的提示词", 400);
    const refs = context.assets().filter(asset => asset.taskId === task.id && ownedAsset(context, actor.id, asset.id) && !isAuxiliaryImageResult(asset.metadata)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 20).map(asset => asset.id);
    return this.create(actor, { title: titleFromPrompt(task.prompt), prompt: task.prompt, targetTool: toolFromOperation(task.operationType, task.parameters || {}), modelConfigId: task.modelConfigId || null, parameters: task.parameters || {}, referenceAssetIds: refs, sourceTaskId: task.id }, context);
  }

  fromAsset(actor: DemoPromptActor, id: string, context: DemoPromptContext) {
    const asset = context.asset(id);
    if (!asset || asset.ownerUserId !== actor.id || !asset.bytes.byteLength) throw notFound();
    const task = asset.taskId ? context.task(asset.taskId) : undefined;
    if (task && task.ownerUserId !== actor.id) throw notFound();
    const metadata = asset.metadata || {};
    const prompt = task?.prompt || (typeof metadata.prompt === "string" ? metadata.prompt : "");
    if (!prompt.trim()) throw new PromptTemplateError("PROMPT_UNAVAILABLE", "该素材没有可保存的提示词", 400);
    const parameters = task?.parameters || metadata;
    return this.create(actor, { title: titleFromPrompt(prompt), prompt, targetTool: toolFromOperation(task?.operationType || String(metadata.operationType || "image_generation"), parameters), modelConfigId: task?.modelConfigId || null, parameters, referenceAssetIds: asset.mimeType.startsWith("image/") ? [id] : [], sourceAssetId: id }, context);
  }

  close() { this.access("关闭个人提示词数据库", () => this.db.close(true)); }

  private snapshot(actor: DemoPromptActor, body: unknown, context: DemoPromptContext): SavedSnapshot {
    const snapshot = promptSnapshotSchema.parse(body);
    if (snapshot.referenceAssetIds.some(id => !ownedAsset(context, actor.id, id))) throw new PromptTemplateError("REFERENCE_UNAVAILABLE", "部分参考图不存在或当前无权访问", 400);
    if (snapshot.sourceAssetId) {
      const asset = context.asset(snapshot.sourceAssetId);
      if (!asset || asset.ownerUserId !== actor.id || !asset.bytes.byteLength) throw notFound();
    }
    if (snapshot.sourceTaskId) {
      const task = context.task(snapshot.sourceTaskId);
      if (!task || task.ownerUserId !== actor.id || task.status !== "success") throw notFound();
    }
    const model = snapshot.modelConfigId ? context.models.find(item => item.id === snapshot.modelConfigId) : undefined;
    if (snapshot.modelConfigId && !model) throw new PromptTemplateError("MODEL_NOT_FOUND", "所选模型不存在", 400);
    return { ...snapshot, modelConfigId: snapshot.modelConfigId || null, sourceTaskId: snapshot.sourceTaskId || null, sourceAssetId: snapshot.sourceAssetId || null, modelSnapshot: model ? publicModel(model, actor, context) : {} };
  }

  private row(ownerId: string, id: string) {
    const row = this.db.query<TemplateRow, [string, string]>("SELECT * FROM demo_prompt_templates WHERE id=? AND owner_user_id=? AND deleted=0").get(id, ownerId);
    if (!row) throw notFound();
    return row;
  }
  private envelope(row: TemplateRow, version: VersionRow) {
    const snapshot = JSON.parse(version.fields_json) as SavedSnapshot;
    return { ...snapshot, id: row.id, scope: "personal" as const, ownerUserId: row.owner_user_id, groupId: null, departmentId: row.department_id, currentVersionId: version.id, version: version.version, favorite: Boolean(row.favorite), useCount: row.use_count, lastUsedAt: row.last_used_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private now() { return new Date(this.clock()).toISOString(); }
  private access<T>(operation: string, action: () => T): T {
    try { return action(); } catch (error) { if (error instanceof PromptTemplateError || error instanceof z.ZodError || error instanceof DemoStorageError) throw error; throw new DemoStorageError(operation, error); }
  }
}

function publicModel(model: Record<string, unknown>, actor: DemoPromptActor, context: DemoPromptContext) {
  const provider = context.providers.find(item => item.id === model.providerId);
  return presentPublicModel({ ...model, protocol: provider?.protocol, creditCost: context.creditsEnabled ? Number(model.creditCost || 0) : 0 }, actor.role);
}

function resolveDemoPromptPricing(actor: DemoPromptActor, template: PromptSnapshot, context: DemoPromptContext) {
  const operationType = operationForPromptTool(template.targetTool);
  const source = typeof template.parameters.toolKey === "string" ? template.parameters.toolKey : typeof template.parameters.tool === "string" ? template.parameters.tool : template.targetTool === "batch-edit" ? "canvas-batch" : template.targetTool === "canvas" ? "canvas-image" : template.targetTool;
  const toolKey = resolveToolKey(operationType, source), definition = toolKey ? getToolDefinition(toolKey) : undefined;
  const binding = context.tools.find(tool => tool.toolKey === toolKey);
  const unavailable = { operationType, modelChanged: false, reason: "tool_unavailable", selectedModel: null, estimate: null, alternatives: [] };
  if (!definition || !(definition.operations as readonly string[]).includes(operationType) || binding?.enabled === false || context.moduleEnabled?.(toolKey!) === false) return unavailable;
  const candidates: PromptModelCandidate[] = context.models.map(model => {
    const provider = context.providers.find(item => item.id === model.providerId);
    return { id: String(model.id), name: String(model.name), modelId: String(model.modelId), capabilities: Array.isArray(model.capabilities) ? model.capabilities as string[] : [], creditCost: context.creditsEnabled ? Number(model.creditCost || 0) : 0, rmbCost: Number(model.rmbCost || 0), enabled: model.enabled === true && isSelectableCreativeModel({ ...model, protocol: provider?.protocol }), providerEnabled: provider?.enabled === true && provider.hasCredentials === true, replacementModelConfigId: typeof model.replacementModelConfigId === "string" ? model.replacementModelConfigId : null };
  });
  const boundId = typeof binding?.modelConfigId === "string" ? binding.modelConfigId : null;
  const resolution = resolvePromptModel(boundId || template.modelConfigId, operationType, candidates);
  if (boundId && resolution.selected?.id !== boundId) return { ...unavailable, modelChanged: true, reason: "configured_model_unavailable" };
  const quantity = quantityFromParameters(template.parameters);
  const rawRule = context.prices.find(price => price.operationType === operationType && price.status === "published")
    ?? (binding?.creditCostOverride != null && binding?.rmbCostOverride != null ? { credits: 0, rmbCost: 0, version: 0 } : undefined);
  if (!rawRule) return { ...unavailable, reason: "price_unavailable" };
  const rule = { operationType, credits: context.creditsEnabled ? Number(rawRule?.credits || 0) : 0, rmbCost: Number(rawRule?.rmbCost || 0), version: Number(rawRule?.version || 0) };
  const configuration: ToolConfiguration | undefined = binding && toolKey ? {
    toolKey, modelConfigId: boundId, enabled: binding.enabled !== false,
    creditCostOverride: binding.creditCostOverride != null ? (context.creditsEnabled ? Number(binding.creditCostOverride) : 0) : null,
    rmbCostOverride: binding.rmbCostOverride != null ? Number(binding.rmbCostOverride) : null,
    configurationVersion: Number(binding.configurationVersion || 0),
  } : undefined;
  const estimate = (model: PromptModelCandidate) => pricePromptModel(model, rule, quantity, configuration);
  const present = (candidate: PromptModelCandidate) => publicModel(context.models.find(model => model.id === candidate.id)!, actor, context);
  return { operationType, modelChanged: resolution.modelChanged || Boolean(boundId && boundId !== template.modelConfigId), reason: resolution.reason, selectedModel: resolution.selected ? present(resolution.selected) : null, estimate: resolution.selected ? estimate(resolution.selected) : null, alternatives: resolution.alternatives.map(model => ({ model: present(model), estimate: estimate(model) })) };
}

export async function handleDemoPromptTemplates(request: Request, store: DemoPromptTemplateStore, actor: DemoPromptActor | null, context: DemoPromptContext): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname, prefix = "/api/prompt-templates";
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (!actor) return json({ error: "UNAUTHENTICATED", message: "请先完成登录" }, 401);
  if (request.headers.has("x-canvas-owner-id") && request.headers.get("x-canvas-owner-id") !== actor.id) return json({ error: "OWNER_CHANGED", message: "员工会话已变化，请刷新后重试" }, 409);
  try {
    if (path === prefix) {
      if (request.method === "GET") return json(store.list(actor, Object.fromEntries(url.searchParams)));
      if (request.method === "POST") return json({ template: store.create(actor, await request.json(), context) }, 201);
    }
    const action = path.slice(prefix.length + 1).split("/").map(decodeURIComponent);
    if (action[0] === "reuse" && action.length === 2 && request.method === "GET") return json(store.reuse(actor, action[1]!, context));
    if (action[0] === "from-task" && action.length === 2 && request.method === "POST") return json({ template: store.fromTask(actor, action[1]!, context) }, 201);
    if (action[0] === "from-asset" && action.length === 2 && request.method === "POST") return json({ template: store.fromAsset(actor, action[1]!, context) }, 201);
    if (action[0] === "review" && action[1] === "submissions" && action.length === 2 && request.method === "GET") return json({ submissions: [] });
    if (action.length === 1 && action[0]) {
      if (request.method === "GET") return json({ template: store.get(actor, action[0]) });
      if (request.method === "PATCH") return json({ template: store.update(actor, action[0], await request.json(), context) });
      if (request.method === "DELETE") { store.remove(actor, action[0]); return new Response(null, { status: 204 }); }
    }
    if (action.length === 2 && action[0]) {
      if (action[1] === "copy" && request.method === "POST") return json({ template: store.copy(actor, action[0], context) }, 201);
      if (action[1] === "favorite" && request.method === "PUT") return json(store.favorite(actor, action[0], await request.json()));
      if (action[1] === "resolve" && request.method === "POST") return json(store.resolve(actor, action[0], await request.json(), context));
    }
    return json({ error: "PROMPT_OPERATION_UNAVAILABLE", message: "本地模式仅支持个人模板，不提供团队发布或审核" }, 405);
  } catch (error) {
    if (error instanceof PromptTemplateError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "INVALID_PROMPT_TEMPLATE", message: error.issues.map(issue => issue.message).join("；") }, 400);
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "INVALID_REQUEST", message: "请求格式无效" }, 400);
    if (error instanceof DemoStorageError) return json({ error: error.code, message: "个人提示词保存失败，请稍后重试" }, 503);
    throw error;
  }
}

function ownedAsset(context: DemoPromptContext, ownerId: string, id: string) { const asset = context.asset(id); return Boolean(asset && asset.ownerUserId === ownerId && asset.bytes.byteLength && asset.mimeType.startsWith("image/")); }
function titleFromPrompt(prompt: string) { return prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "未命名提示词"; }
function toolFromOperation(operation: string, parameters: Record<string, unknown>): PromptSnapshot["targetTool"] {
  if (operation === "upscale") return "detail-enhance";
  if (operation === "batch_image") return "batch-edit";
  if (operation === "seamless_stitch") return "seamless-stitch";
  if (operation === "video_generation") return "video";
  if (operation === "inpaint") return parameters.tool === "angle-control" || parameters.toolKey === "angle-control" ? "angle-control" : "image-edit";
  return "image-generation";
}
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function notFound() { return new PromptTemplateError("NOT_FOUND", "提示词模板不存在或无权访问", 404); }
