import { Router } from "express";
import { createHash } from "node:crypto";
import type { Cache, Database } from "../db";
import { withTransaction } from "../db-transaction";
import { writeAudit } from "../audit";
import type { AuthenticatedRequest } from "../types";
import { enqueueTask } from "../tasks";
import { ToolConfigurationError } from "../tool-configuration";
import { quickImageTaskTarget } from "../../../shared/quick-image-tools";
import { prepareConfiguredQuickImageTask, quickImageActions, quickImageActionSchema, quickImageConfigurationTestSchema, quickImageConfigurationUpdateSchema,
  readQuickImageConfiguration, readQuickImageModel, readQuickImageModels, validateQuickImageConfiguration } from "../quick-image-configuration";
import type { preflightStoredQuickImageTask } from "../stored-quick-image-preflight";

export type QuickImageRouterOptions = { cache?: Cache; creditPolicy?: boolean | (() => Promise<boolean>); maxInflightTasks?: number; quickImagePreflight?: typeof preflightStoredQuickImageTask };

/** Mounted only behind the model-configuration router's authenticated super-admin guard. */
export function createQuickImageConfigurationRouter(db: Database, options: QuickImageRouterOptions = {}) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try {
      const [configurations, models] = await Promise.all([Promise.all(quickImageActions.map(action => readQuickImageConfiguration(db, action))), readQuickImageModels(db)]);
      response.set("Cache-Control", "no-store").json({ configurations, models });
    } catch (error) { next(error); }
  });
  router.put("/:action", async (request, response, next) => {
    try {
      const action = quickImageActionSchema.parse(request.params.action);
      const { expectedVersion, ...input } = quickImageConfigurationUpdateSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const configuration = await withTransaction(db, async client => {
        // Covers the absent-row case as well as updates; no lost first save.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('quick-image-configuration'),hashtext($1))", [action]);
        const current = (await client.query<{ version: number }>("SELECT configuration_version AS version FROM quick_image_configurations WHERE action=$1 FOR UPDATE", [action])).rows[0];
        if ((current?.version ?? 0) !== expectedVersion) throw new ToolConfigurationError("QUICK_IMAGE_CONFIGURATION_CONFLICT", "配置已被其他管理员修改，请刷新后重试", 409);
        const model = await readQuickImageModel(client, input.modelConfigId);
        const value = validateQuickImageConfiguration(action, input, model);
        await client.query(`INSERT INTO quick_image_configurations(action,model_config_id,prompt,parameters,configuration_version,updated_by)
          VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(action) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,prompt=EXCLUDED.prompt,
          parameters=EXCLUDED.parameters,configuration_version=quick_image_configurations.configuration_version+1,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [action, value.modelConfigId, value.prompt, value.parameters, actor.id]);
        const saved = await readQuickImageConfiguration(client, action);
        await writeAudit(client, { actor, action: "quick_image_configuration.updated", targetType: "quick_image_configuration", targetId: action, result: "success",
          detail: { modelConfigId: saved.modelConfigId, configurationVersion: saved.configurationVersion, parameterKeys: Object.keys(saved.parameters),
            promptHash: createHash("sha256").update(saved.prompt).digest("hex") }, ip: request.ip });
        return saved;
      });
      response.json({ configuration });
    } catch (error) { next(error); }
  });
  router.post("/:action/test", async (request, response, next) => {
    try {
      const action = quickImageActionSchema.parse(request.params.action);
      const input = quickImageConfigurationTestSchema.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const existing = (await db.query(`SELECT id,request_id AS "requestId",status,model_config_id AS "modelConfigId",tool_key AS "toolKey",prompt,parameters,
        result_urls AS "resultUrls",failure_reason AS "failureReason",credits,rmb_cost::float8 AS "rmbCost" FROM tasks WHERE request_id=$1 AND user_id=$2`, [input.requestId, actor.id])).rows[0];
      if (existing) { response.json({ task: existing }); return; }
      if (!options.cache) throw new ToolConfigurationError("QUICK_IMAGE_TEST_UNAVAILABLE", "任务队列尚未配置，未提交测试", 503);
      const prepared = await prepareConfiguredQuickImageTask(db, { requestId: input.requestId, userId: actor.id, departmentId: actor.departmentId,
        projectId: "admin-quick-image-test", ...quickImageTaskTarget(action), prompt: "", parameters: { quickImageAction: action },
        sourceUrls: [input.sourceUrl], priority: "normal" as const, optimized: false }, input.configuration);
      const creditsEnabled = typeof options.creditPolicy === "function" ? await options.creditPolicy() : options.creditPolicy ?? true;
      const task = await enqueueTask(db, options.cache, { ...prepared, creditsEnabled, maxInflightTasks: options.maxInflightTasks }, undefined, options.quickImagePreflight);
      response.status(201).json({ task: { ...task, prompt: prepared.prompt, parameters: prepared.parameters, optimized: false } });
    } catch (error) { next(error); }
  });
  return router;
}
