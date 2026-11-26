import { Router } from "express";
import { z } from "zod";
import { preflightApiMartImageRequest } from "../apimart-image";
import { writeAudit } from "../audit";
import type { Database } from "../db";
import { withTransaction } from "../db-transaction";
import { getDefaultImageModelId, listImageDefaultCandidates, readImageGenerationDefaults } from "../image-generation-defaults";
import { presentPublicModel } from "../model-presentation";
import { openAiImageParameters } from "../openai-image-parameters";
import type { AuthenticatedRequest } from "../types";

const inputSchema = z.object({
  defaultModelConfigId: z.string().uuid().nullable().optional(),
  modelConfigId: z.string().uuid(),
  options: z.object({
    size: z.string().trim().max(32).min(1).optional(),
    quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
    resolution: z.enum(["0.5k", "1k", "2k", "4k"]).optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    complexity: z.enum(["low", "medium", "high"]).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    negative_prompt: z.string().trim().min(1).max(2000).optional(),
    nsfw_check: z.boolean().optional(),
    official_fallback: z.boolean().optional(),
    web_grounding: z.boolean().optional(),
    google_search: z.boolean().optional(),
    google_image_search: z.boolean().optional(),
  }).strict().optional(),
}).strict();

async function configuration(db: Pick<Database, "query">) {
  const [models, saved] = await Promise.all([listImageDefaultCandidates(db), readImageGenerationDefaults(db)]);
  return {
    models: models.map(model => presentPublicModel(model, "super_admin")),
    ...saved,
    systemDefaultModelConfigId: getDefaultImageModelId(models, null),
    effectiveModelConfigId: getDefaultImageModelId(models, saved.defaultModelConfigId),
  };
}

export function createImageGenerationDefaultsRouter(db: Database) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try { response.json({ code: 0, data: await configuration(db), msg: "" }); }
    catch (error) { next(error); }
  });
  router.put("/", async (request, response, next) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ code: "INVALID_IMAGE_DEFAULTS", msg: "默认图片模型或参数格式错误" }); return; }
    const { defaultModelConfigId, modelConfigId, options } = parsed.data;
    try {
      const failure = await withTransaction(db, async client => {
        const models = await listImageDefaultCandidates(client, true);
        const model = models.find(item => item.id === modelConfigId);
        if (!model || (defaultModelConfigId && !models.some(item => item.id === defaultModelConfigId))) return "请选择已启用且支持文生图和图生图的模型";
        try {
          if (options && Object.keys(options).length) {
            const payload = model.protocol === "apimart"
              ? preflightApiMartImageRequest({ modelId: model.modelId, prompt: "校验默认图像设置", parameters: options }).payload
              : openAiImageParameters(options, model.modelId);
            if (Object.keys(options).some(key => !Object.hasOwn(payload, key))) return "当前模型不支持其中一项默认参数";
          }
        } catch (error) { return error instanceof Error ? error.message : "当前模型不支持所选默认参数"; }
        await client.query(`INSERT INTO image_generation_defaults(singleton,default_model_config_id,model_options)
          VALUES(true,$1,$2::jsonb)
          ON CONFLICT(singleton) DO UPDATE SET default_model_config_id=CASE WHEN $3 THEN EXCLUDED.default_model_config_id ELSE image_generation_defaults.default_model_config_id END,
          model_options=image_generation_defaults.model_options || EXCLUDED.model_options,updated_at=now()`,
        [defaultModelConfigId ?? null, JSON.stringify(options ? { [modelConfigId]: options } : {}), defaultModelConfigId !== undefined]);
        await writeAudit(client, { actor: (request as unknown as AuthenticatedRequest).auth, action: "image_defaults.updated",
          targetType: "model", targetId: modelConfigId, result: "success", detail: parsed.data, ip: request.ip });
        return null;
      });
      if (failure) { response.status(400).json({ code: "INVALID_IMAGE_DEFAULTS", msg: failure }); return; }
      response.json({ code: 0, data: await configuration(db), msg: "" });
    } catch (error) { next(error); }
  });
  return router;
}
