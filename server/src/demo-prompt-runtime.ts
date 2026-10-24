import { z, ZodError } from "zod";
import { promptCompilationRequestSchema, promptRecipeSettingsSchema, promptRecipeVersionSchema } from "../../shared/prompt-contracts";
import type { ModuleKey } from "../../shared/feature-catalog";
import { PromptCompiler, type PromptActor } from "./prompt-compiler";
import { PromptRecipeStore, promptHash, publicPromptCompilation, type PromptSql } from "./prompt-recipe-store";
import { promptRuntimeModelFingerprint, promptSourceFromBytes } from "./prompt-runtime";
import { PromptOptimizationError } from "./prompt-safety";
import { resolveDemoToolConfiguration } from "./demo-tool-configuration";
import { CHAT_COMPLETION_PROTOCOLS, requestChatCompletion } from "./routes/chat";

type Asset = { id: string; ownerUserId: string; mimeType: string; byteSize?: number; bytes: Uint8Array; deletedAt?: string };
type Configuration = {
  models: Array<Record<string, unknown>>;
  providers: Array<Record<string, unknown>>;
  tools: Array<{ toolKey: string; modelConfigId: string | null; enabled: boolean; configurationVersion?: number }>;
  flags: Partial<Record<ModuleKey, boolean>>;
  credential: (providerId: string) => string;
  asset: (id: string) => Asset | undefined;
};

/** Uses the same compiler, immutable versions, source checks, and accounting as PG. */
export function createDemoPromptCompiler(store: PromptRecipeStore, config: Configuration) {
  return new PromptCompiler(store, {
    resolveTarget: async (_actor, request) => {
      const operationType = request.promptInput.scene === "batch-optimize" ? "batch_image" : request.promptInput.mode === "generate" ? "image_generation" : "inpaint";
      const execution = resolveDemoToolConfiguration({ operationType, toolKey: request.toolKey, modelConfigId: request.modelConfigId }, config.tools, config.models, config.providers, config.flags);
      const model = config.models.find(item => item.id === execution.modelConfigId)!;
      const provider = config.providers.find(item => item.id === model.providerId)!;
      return { id: String(model.id), modelId: String(model.modelId), protocol: String(provider.protocol), workflowConfigId: typeof model.workflowConfigId === "string" ? model.workflowConfigId : null,
        fingerprint: promptHash({ model: promptRuntimeModelFingerprint(model, provider), workflow: model.workflowConfigId ?? null, binding: config.tools.find(item => item.toolKey === execution.toolKey)?.configurationVersion ?? 0 }) };
    },
    resolveOptimizer: async id => {
      const model = config.models.find(item => item.id === id && item.enabled === true && Array.isArray(item.capabilities) && item.capabilities.includes("chat"));
      const provider = model && config.providers.find(item => item.id === model.providerId && item.enabled === true);
      if (!model || !provider || !(CHAT_COMPLETION_PROTOCOLS as readonly string[]).includes(String(provider.protocol))) throw new PromptOptimizationError("PROMPT_MODEL_UNAVAILABLE", "配方绑定的扩写模型不可用，未提交生成", 503);
      const apiKey = config.credential(String(provider.id));
      if (!apiKey) throw new PromptOptimizationError("PROMPT_MODEL_NOT_CONFIGURED", "扩写模型的服务端凭据未配置，未提交生成", 503);
      const upstream = { model_id: String(model.modelId), base_url: String(provider.baseUrl), protocol: String(provider.protocol), encrypted_credentials: null };
      return { id: String(model.id), modelId: String(model.modelId), fingerprint: promptRuntimeModelFingerprint(model, provider), estimatedRmbCost: Number(model.rmbCost) > 0 ? Number(model.rmbCost) : null,
        invoke: (system, content) => requestChatCompletion(upstream, { apiKey }, { input: [{ role: "system", content: system }, { role: "user", content }], tools: [], privateProfile: true, claude: { thinking: false, stream: false, maxTokens: 4096 }, gemini: { maxOutputTokens: 4096 } }),
      };
    },
    readSource: async (actor, url) => {
      const id = url.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/i)?.[1];
      if (!id) throw new PromptOptimizationError("PROMPT_REFERENCE_INVALID", "优化仅接受当前站点中有权访问的参考素材");
      const asset = config.asset(id);
      // Match Demo task admission: owning the asset is required; metadata access is not enough.
      if (!asset || asset.ownerUserId !== actor.id || asset.deletedAt || (asset.byteSize !== undefined && asset.byteSize > 50 * 1024 * 1024)) throw new PromptOptimizationError("PROMPT_REFERENCE_FORBIDDEN", "参考图不存在、超出大小限制或无权访问", 403);
      return promptSourceFromBytes(asset.bytes, asset.mimeType);
    },
  });
}

const testSchema = promptCompilationRequestSchema.extend({ versionId: z.string().uuid(), optimizerModelConfigId: z.string().min(1).max(200).optional() });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Runtime keeps its existing admin gate. This adapter never creates a session or elevates a role. */
export async function handleDemoPromptRecipes(request: Request, compiler: PromptCompiler, actor: PromptActor | null, context: { models: () => Promise<unknown[]>; audit: (actor: PromptActor, action: string, key: string, client: PromptSql) => Promise<void> }) {
  const path = new URL(request.url).pathname;
  const publicRoot = "/api/prompt-compilations", adminRoot = "/api/admin/prompt-recipes";
  const isPublic = path === publicRoot || path.startsWith(publicRoot + "/"), isAdmin = path === adminRoot || path.startsWith(adminRoot + "/");
  if (!isPublic && !isAdmin) return null;
  if (!actor) return json({ error: "UNAUTHORIZED", message: "请先登录" }, 401);
  if (isAdmin && actor.role !== "super_admin") return json({ error: "FORBIDDEN", message: "仅超级管理员可维护提示词配方" }, 403);
  try {
    if (isPublic) {
      if (path === publicRoot && request.method === "POST") {
        const value = await compiler.compile(actor, promptCompilationRequestSchema.parse(await request.json()));
        return json({ compilation: publicPromptCompilation(value) }, value.status === "optimizing" ? 202 : 200);
      }
      const match = path.match(/^\/api\/prompt-compilations\/by-request\/([^/]+)$/);
      if (match && request.method === "GET") {
        const value = await compiler.store.byRequest(actor.id, decodeURIComponent(match[1]!));
        return value ? json({ compilation: publicPromptCompilation(value) }) : json({ error: "NOT_FOUND", message: "优化请求不存在" }, 404);
      }
    } else {
      if (path === adminRoot && request.method === "GET") return json({ recipes: await compiler.store.list(), models: await context.models() });
      const match = path.match(/^\/api\/admin\/prompt-recipes\/([^/]+)(?:\/(versions|activate|test|compilations)(?:\/([^/]+))?)?$/);
      if (match) {
        const key = decodeURIComponent(match[1]!), action = match[2];
        if (!action && request.method === "GET") {
          const [recipe, versions, stats, compilations] = await Promise.all([compiler.store.get(key), compiler.store.versions(key), compiler.store.stats(key), compiler.store.recent(key)]);
          return json({ recipe, versions, stats, compilations });
        }
        if (!action && request.method === "PATCH") {
          const settings = promptRecipeSettingsSchema.parse(await request.json());
          if (settings.modelConfigId) await compiler.runtime.resolveOptimizer(settings.modelConfigId);
          const recipe = await compiler.store.audited(store => store.update(key, settings), client => context.audit(actor, "prompt_recipe.updated", key, client));
          return json({ recipe });
        }
        if (action === "versions" && request.method === "POST") {
          await compiler.store.get(key);
          const content = promptRecipeVersionSchema.parse(await request.json());
          const version = await compiler.store.audited(store => store.saveVersion(key, content, actor.id), client => context.audit(actor, "prompt_recipe.version_saved", key, client));
          return json({ version }, 201);
        }
        if (action === "activate" && request.method === "POST") {
          const { versionId } = z.object({ versionId: z.string().uuid() }).strict().parse(await request.json());
          const recipe = await compiler.store.audited(store => store.activate(key, versionId), client => context.audit(actor, "prompt_recipe.activated", key, client));
          return json({ recipe });
        }
        if (action === "test" && request.method === "POST") {
          const { versionId, optimizerModelConfigId, ...input } = testSchema.parse(await request.json());
          if (input.promptInput.scene !== key) throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH", "试运行场景与配方不一致");
          return json({ compilation: publicPromptCompilation(await compiler.compile(actor, input, { versionId, optimizerModelConfigId })) });
        }
        if (action === "compilations" && match[3] && request.method === "GET") {
          const compilation = await compiler.store.getCompilation(decodeURIComponent(match[3]));
          return compilation?.recipeKey === key ? json({ compilation }) : json({ error: "NOT_FOUND", message: "优化记录不存在" }, 404);
        }
      }
    }
    return json({ error: "NOT_FOUND", message: "提示词优化接口不存在" }, 404);
  } catch (error) {
    if (error instanceof PromptOptimizationError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof URIError) return json({ error: "INVALID_PROMPT_INPUT", message: "提示词优化输入格式无效" }, 400);
    throw error;
  }
}
