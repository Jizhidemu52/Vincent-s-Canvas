import { createHash, randomUUID } from "node:crypto";
import type { AdminPromptCompilation, AdminPromptRecipe, AdminPromptRecipeVersion, PromptRecipeSettings, PromptRecipeStats, PromptRecipeVersionContent, PublicPromptCompilation } from "../../shared/prompt-contracts";
import { promptRecipeSettingsSchema, promptRecipeVersionSchema } from "../../shared/prompt-contracts";
import { PromptOptimizationError } from "./prompt-safety";

export type PromptSql = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  lock(key: string): Promise<void>;
};
export type PromptDatabase = PromptSql & { transaction<T>(action: (client: PromptSql) => Promise<T>): Promise<T> };
type RecipeRow = { key: string; settings: unknown; current_version_id: string | null; updated_at: string };
type VersionRow = { id: string; recipe_key: string; version: number; content_hash: string; content: unknown; created_by: string; created_at: string };
type CompilationRow = { id: string; user_id: string; request_id: string; input_hash: string; recipe_key: string; recipe_version_id: string; status: PublicPromptCompilation["status"]; reused_from_id: string | null; details: unknown; created_at: string };
type CompilationDetails = Omit<AdminPromptCompilation, "id" | "userId" | "requestId" | "inputHash" | "recipeKey" | "recipeVersionId" | "status" | "reusedFromId" | "createdAt" | "cacheHit">;
export type CompilationClaim = { userId: string; requestId: string; inputHash: string; recipeKey: string; recipeVersionId: string; details: CompilationDetails };
const json = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const recipe = (row: RecipeRow): AdminPromptRecipe => ({ ...json<PromptRecipeSettings>(row.settings), key: row.key, currentVersionId: row.current_version_id, updatedAt: row.updated_at });
const version = (row: VersionRow): AdminPromptRecipeVersion => ({ ...json<PromptRecipeVersionContent>(row.content), id: row.id, recipeKey: row.recipe_key, version: Number(row.version), contentHash: row.content_hash, createdBy: row.created_by, createdAt: row.created_at });

export function stablePromptJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePromptJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stablePromptJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const promptHash = (value: unknown) => createHash("sha256").update(stablePromptJson(value)).digest("hex");

/** Both runtimes use the same lifecycle and serializers; only SQL transport differs. */
export class PromptRecipeStore {
  constructor(readonly database: PromptDatabase, private readonly clock: () => Date = () => new Date()) {}

  /** Authoring changes and their audit record commit together, without nested transactions. */
  async audited<T>(action: (store: PromptRecipeStore) => Promise<T>, audit: (client: PromptSql) => Promise<void>): Promise<T> {
    return this.database.transaction(async client => {
      const scoped = new PromptRecipeStore({ ...client, transaction: operation => operation(client) }, this.clock);
      const result = await action(scoped);
      await audit(client);
      return result;
    });
  }

  async list() { return (await this.database.query<RecipeRow>("SELECT * FROM prompt_recipes ORDER BY key")).rows.map(recipe); }
  async get(key: string) {
    const row = (await this.database.query<RecipeRow>("SELECT * FROM prompt_recipes WHERE key=$1", [key])).rows[0];
    if (!row) throw new PromptOptimizationError("PROMPT_RECIPE_UNAVAILABLE", "管理员尚未配置此场景的优化配方，未提交生成", 503);
    return recipe(row);
  }
  async ensure(key: string, settings: PromptRecipeSettings) {
    if (!/^[a-z][a-z0-9-]{1,99}$/.test(key)) throw new PromptOptimizationError("PROMPT_RECIPE_INVALID", "配方标识无效");
    await this.database.query("INSERT INTO prompt_recipes(key,settings,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING", [key, JSON.stringify(promptRecipeSettingsSchema.parse(settings)), this.clock().toISOString()]);
    return this.get(key);
  }
  async update(key: string, settings: PromptRecipeSettings) {
    await this.get(key);
    await this.database.query("UPDATE prompt_recipes SET settings=$1,updated_at=$2 WHERE key=$3", [JSON.stringify(promptRecipeSettingsSchema.parse(settings)), this.clock().toISOString(), key]);
    return this.get(key);
  }
  async versions(key: string) { return (await this.database.query<VersionRow>("SELECT * FROM prompt_recipe_versions WHERE recipe_key=$1 ORDER BY version DESC", [key])).rows.map(version); }
  async getVersion(id: string, key?: string) {
    const row = (await this.database.query<VersionRow>("SELECT * FROM prompt_recipe_versions WHERE id=$1", [id])).rows[0];
    if (!row || (key && row.recipe_key !== key)) throw new PromptOptimizationError("PROMPT_VERSION_NOT_FOUND", "配方版本不存在", 404);
    return version(row);
  }
  async saveVersion(key: string, content: PromptRecipeVersionContent, actorId: string) {
    const parsed = promptRecipeVersionSchema.parse(content);
    const contentHash = promptHash(parsed);
    return this.database.transaction(async client => {
      await client.lock(`prompt-version:${key}`);
      const existing = (await client.query<VersionRow>("SELECT * FROM prompt_recipe_versions WHERE recipe_key=$1 AND content_hash=$2", [key, contentHash])).rows[0];
      if (existing) return version(existing);
      const next = (await client.query<{ next: number }>("SELECT COALESCE(MAX(version),0)+1 AS next FROM prompt_recipe_versions WHERE recipe_key=$1", [key])).rows[0]!;
      const rows = await client.query<VersionRow>("INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [randomUUID(), key, Number(next.next), contentHash, JSON.stringify(parsed), actorId, this.clock().toISOString()]);
      return version(rows.rows[0]!);
    });
  }
  async activate(key: string, id: string) {
    await this.getVersion(id, key);
    await this.database.query("UPDATE prompt_recipes SET current_version_id=$1,updated_at=$2 WHERE key=$3", [id, this.clock().toISOString(), key]);
    return this.get(key);
  }
  async active(key: string, selectedVersionId?: string) {
    const current = await this.get(key);
    if (!current.enabled) throw new PromptOptimizationError("PROMPT_RECIPE_DISABLED", "此场景的提示词优化已停用，未提交生成", 503);
    const id = selectedVersionId ?? current.currentVersionId;
    if (!id) throw new PromptOptimizationError("PROMPT_RECIPE_UNAVAILABLE", "管理员尚未启用此场景的配方版本，未提交生成", 503);
    return { recipe: current, version: await this.getVersion(id, key) };
  }
  async claim(input: CompilationClaim) {
    return this.database.transaction(async client => {
      await client.lock(`prompt-compile:${input.userId}:${input.inputHash}`);
      const existing = (await client.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE user_id=$1 AND request_id=$2", [input.userId, input.requestId])).rows[0];
      if (existing) {
        if (existing.input_hash !== input.inputHash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "同一请求编号的优化输入已改变，请新建请求", 409);
        return { id: existing.id, execute: false };
      }
      const cached = (await client.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE user_id=$1 AND input_hash=$2 AND reused_from_id IS NULL AND status IN ('success','optimizing','uncertain') ORDER BY created_at DESC LIMIT 1", [input.userId, input.inputHash])).rows[0];
      const id = randomUUID();
      const inserted = await client.query<CompilationRow>("INSERT INTO prompt_compilations(id,user_id,request_id,input_hash,recipe_key,recipe_version_id,status,reused_from_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_id,request_id) DO NOTHING RETURNING *", [id, input.userId, input.requestId, input.inputHash, input.recipeKey, input.recipeVersionId, cached?.status ?? "optimizing", cached?.id ?? null, JSON.stringify(input.details), this.clock().toISOString()]);
      if (!inserted.rows.length) {
        const raced = (await client.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE user_id=$1 AND request_id=$2", [input.userId, input.requestId])).rows[0]!;
        if (raced.input_hash !== input.inputHash) throw new PromptOptimizationError("PROMPT_REQUEST_CHANGED", "同一请求编号的优化输入已改变，请新建请求", 409);
        return { id: raced.id, execute: false };
      }
      return { id, execute: !cached };
    });
  }
  async finish(id: string, status: PublicPromptCompilation["status"], patch: Partial<CompilationDetails>) {
    return this.database.transaction(async client => {
      await client.lock(`prompt-result:${id}`);
      const row = (await client.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE id=$1", [id])).rows[0];
      if (!row || row.reused_from_id || row.status !== "optimizing") return;
      const details = { ...json<CompilationDetails>(row.details), ...patch, completedAt: this.clock().toISOString() };
      await client.query("UPDATE prompt_compilations SET status=$1,details=$2 WHERE id=$3 AND status='optimizing'", [status, JSON.stringify(details), id]);
    });
  }
  private async present(row: CompilationRow): Promise<AdminPromptCompilation> {
    const source = row.reused_from_id ? (await this.database.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE id=$1", [row.reused_from_id])).rows[0] : row;
    const details = json<CompilationDetails>(source?.details ?? row.details);
    let status = source?.status ?? row.status;
    const expired = status === "optimizing" && this.clock().getTime() - Date.parse(source?.created_at ?? row.created_at) > 200_000;
    if (expired) status = "uncertain";
    return { ...details, id: row.id, userId: row.user_id, requestId: row.request_id, inputHash: row.input_hash,
      recipeKey: row.recipe_key, recipeVersionId: row.recipe_version_id, status, reusedFromId: row.reused_from_id,
      cacheHit: Boolean(row.reused_from_id), createdAt: row.created_at,
      ...(expired ? { errorCode: "PROMPT_SUBMISSION_UNCERTAIN", message: "提示词优化状态待核查，不会自动重新提交；请联系管理员核查原请求" } : {}),
    };
  }
  async getCompilation(id: string, userId?: string) {
    const row = (await this.database.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE id=$1", [id])).rows[0];
    if (!row || (userId && row.user_id !== userId)) return null;
    return this.present(row);
  }
  async byRequest(userId: string, requestId: string) {
    const row = (await this.database.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE user_id=$1 AND request_id=$2", [userId, requestId])).rows[0];
    return row ? this.present(row) : null;
  }
  async recent(key: string, limit = 20) {
    const rows = (await this.database.query<CompilationRow>("SELECT * FROM prompt_compilations WHERE recipe_key=$1 ORDER BY created_at DESC LIMIT $2", [key, limit])).rows;
    return Promise.all(rows.map(row => this.present(row)));
  }
  async stats(key: string): Promise<PromptRecipeStats> {
    const rows = (await this.database.query<{ status: string; reused_from_id: string | null; latency: string | number | null; input_tokens: string | number | null; output_tokens: string | number | null; actual: string | number | null; estimated: string | number | null; currency: string | null }>(
      `SELECT COALESCE(r.status,c.status) AS status,c.reused_from_id,
        c.details->>'latencyMs' AS latency,c.details->>'inputTokens' AS input_tokens,c.details->>'outputTokens' AS output_tokens,
        c.details->>'actualCost' AS actual,c.details->>'estimatedCost' AS estimated,c.details->>'currency' AS currency
       FROM prompt_compilations c LEFT JOIN prompt_compilations r ON r.id=c.reused_from_id WHERE c.recipe_key=$1`, [key])).rows;
    const executed = rows.filter(row => !row.reused_from_id);
    const latencies = executed.filter(row => row.latency !== null);
    const costs = new Map<string, { currency: string; actual: number; estimated: number; unknownCount: number }>();
    for (const row of executed) {
      const currency = row.currency || "unknown";
      const cost = costs.get(currency) ?? { currency, actual: 0, estimated: 0, unknownCount: 0 };
      if (row.actual !== null) cost.actual += Number(row.actual);
      else if (row.estimated !== null) cost.estimated += Number(row.estimated);
      else cost.unknownCount++;
      costs.set(currency, cost);
    }
    const cny = costs.get("CNY");
    return { total: rows.length, success: rows.filter(row => row.status === "success").length, failed: rows.filter(row => row.status === "failed" || row.status === "uncertain").length,
      cacheHits: rows.length - executed.length, averageLatencyMs: latencies.length ? latencies.reduce((sum, row) => sum + Number(row.latency), 0) / latencies.length : null,
      inputTokens: executed.reduce((sum, row) => sum + Number(row.input_tokens ?? 0), 0), outputTokens: executed.reduce((sum, row) => sum + Number(row.output_tokens ?? 0), 0),
      actualCost: cny?.actual ?? 0, estimatedCost: cny?.estimated ?? 0, unknownCostCount: [...costs.values()].reduce((sum, row) => sum + row.unknownCount, 0), costs: [...costs.values()],
    };
  }
}

export function publicPromptCompilation(value: AdminPromptCompilation): PublicPromptCompilation {
  return { id: value.id, requestId: value.requestId, status: value.status, optimized: value.status === "success" && value.optimized,
    ...(value.status === "success" ? { prompt: value.prompt, ...(value.summaryZh ? { summaryZh: value.summaryZh } : {}) } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}), ...(value.message ? { message: value.message } : {}),
  };
}
