import { Router } from "express";
import type { Database } from "../db";
import { assertModuleEnabled } from "../module-flags";
import { getVideoModelCapability, isSupportedVideoModelId } from "../video-models";
import { readToolConfiguration, ToolConfigurationError } from "../tool-configuration";

export function createGenerationCapabilitiesRouter(db: Database) {
  const router = Router();
  router.get("/", async (request, response, next) => {
    try {
      const toolKey = request.query.toolKey ?? "video";
      if (toolKey !== "video" && toolKey !== "canvas-video") {
        response.status(400).json({ error: "INVALID_TOOL_KEY", message: "视频能力来源板块无效" }); return;
      }
      await assertModuleEnabled(db, toolKey);
      const binding = await readToolConfiguration(db, toolKey);
      if (!binding.enabled) throw new ToolConfigurationError("TOOL_DISABLED", "该功能的模型调用已停用", 403);
      const result = await db.query<{ id: string; name: string; modelId: string }>(
        `SELECT m.id,m.name,m.model_id AS "modelId" FROM model_configs m JOIN providers p ON p.id=m.provider_id
         WHERE m.enabled=true AND p.enabled=true AND p.protocol='apimart' AND p.encrypted_credentials IS NOT NULL AND 'video'=ANY(m.capabilities)
         ORDER BY m.name,m.id`,
      );
      response.json({ models: result.rows.filter(model => !binding.modelConfigId || model.id === binding.modelConfigId).flatMap((model) => isSupportedVideoModelId(model.modelId)
        ? [{ ...model, capability: getVideoModelCapability(model.modelId) }] : []) });
    } catch (error) { next(error); }
  });
  return router;
}
