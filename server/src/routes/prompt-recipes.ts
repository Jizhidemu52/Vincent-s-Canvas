import { Router, type RequestHandler } from "express";
import { z, ZodError } from "zod";
import { promptCompilationRequestSchema, promptRecipeSettingsSchema, promptRecipeVersionSchema } from "../../../shared/prompt-contracts";
import type { PromptCompiler } from "../prompt-compiler";
import { publicPromptCompilation, type PromptSql } from "../prompt-recipe-store";
import { PromptOptimizationError } from "../prompt-safety";
import { requireRole } from "../rbac";
import type { AuthenticatedRequest } from "../types";

export function createPromptCompilationsRouter(compiler: PromptCompiler) {
  const router = Router();
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  router.post("/", route(async (request, response) => {
    const compilation = await compiler.compile((request as AuthenticatedRequest).auth, promptCompilationRequestSchema.parse(request.body));
    response.status(compilation.status === "optimizing" ? 202 : 200).json({ compilation: publicPromptCompilation(compilation) });
  }));
  router.get("/by-request/:requestId", route(async (request, response) => {
    const value = await compiler.store.byRequest((request as AuthenticatedRequest).auth.id, String(request.params.requestId));
    if (!value) { response.status(404).json({ error: "NOT_FOUND", message: "优化请求不存在" }); return; }
    response.json({ compilation: publicPromptCompilation(value) });
  }));
  return router;
}

const testSchema = promptCompilationRequestSchema.extend({ versionId: z.string().uuid(), optimizerModelConfigId: z.string().min(1).max(200).optional() });
export function createAdminPromptRecipesRouter(compiler: PromptCompiler, models: () => Promise<unknown[]>, audit: (actor: AuthenticatedRequest["auth"], action: string, key: string, client: PromptSql) => Promise<void>) {
  const router = Router();
  router.use(requireRole("super_admin"));
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  router.get("/", route(async (_request, response) => { response.json({ recipes: await compiler.store.list(), models: await models() }); }));
  router.get("/:key", route(async (request, response) => {
    const key = String(request.params.key);
    const [recipe, versions, stats, compilations] = await Promise.all([compiler.store.get(key), compiler.store.versions(key), compiler.store.stats(key), compiler.store.recent(key)]);
    response.json({ recipe, versions, stats, compilations });
  }));
  router.patch("/:key", route(async (request, response) => {
    const key = String(request.params.key);
    const settings = promptRecipeSettingsSchema.parse(request.body);
    if (settings.modelConfigId) await compiler.runtime.resolveOptimizer(settings.modelConfigId);
    const recipe = await compiler.store.audited(store => store.update(key, settings), client => audit((request as AuthenticatedRequest).auth, "prompt_recipe.updated", key, client));
    response.json({ recipe });
  }));
  router.post("/:key/versions", route(async (request, response) => {
    const key = String(request.params.key);
    await compiler.store.get(key);
    const content = promptRecipeVersionSchema.parse(request.body);
    const version = await compiler.store.audited(store => store.saveVersion(key, content, (request as AuthenticatedRequest).auth.id), client => audit((request as AuthenticatedRequest).auth, "prompt_recipe.version_saved", key, client));
    response.status(201).json({ version });
  }));
  router.post("/:key/activate", route(async (request, response) => {
    const key = String(request.params.key);
    const { versionId } = z.object({ versionId: z.string().uuid() }).strict().parse(request.body);
    const recipe = await compiler.store.audited(store => store.activate(key, versionId), client => audit((request as AuthenticatedRequest).auth, "prompt_recipe.activated", key, client));
    response.json({ recipe });
  }));
  router.post("/:key/test", route(async (request, response) => {
    const { versionId, optimizerModelConfigId, ...input } = testSchema.parse(request.body);
    if (input.promptInput.scene !== request.params.key) throw new PromptOptimizationError("PROMPT_RECIPE_MISMATCH", "试运行场景与配方不一致");
    const compilation = await compiler.compile((request as AuthenticatedRequest).auth, input, { versionId, optimizerModelConfigId });
    response.json({ compilation: publicPromptCompilation(compilation) });
  }));
  router.get("/:key/compilations/:id", route(async (request, response) => {
    const compilation = await compiler.store.getCompilation(String(request.params.id));
    if (!compilation || compilation.recipeKey !== request.params.key) { response.status(404).json({ error: "NOT_FOUND", message: "优化记录不存在" }); return; }
    response.json({ compilation });
  }));
  return router;
}

function route(action: RequestHandler): RequestHandler {
  return async (request, response, next) => {
    try { await action(request, response, next); }
    catch (error) {
      if (error instanceof PromptOptimizationError) { response.status(error.status).json({ error: error.code, message: error.message }); return; }
      if (error instanceof ZodError) { response.status(400).json({ error: "INVALID_PROMPT_INPUT", message: "提示词优化输入格式无效" }); return; }
      next(error);
    }
  };
}
