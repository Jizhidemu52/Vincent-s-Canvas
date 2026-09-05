import { Router } from "express";
import type { Database } from "../db";
import { assertModuleEnabled } from "../module-flags";
import { getVideoModelCapability, isSupportedVideoModelId } from "../video-models";

export function createGenerationCapabilitiesRouter(db: Database) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try {
      await assertModuleEnabled(db, "video");
      const result = await db.query<{ id: string; name: string; modelId: string }>(
        `SELECT m.id,m.name,m.model_id AS "modelId" FROM model_configs m JOIN providers p ON p.id=m.provider_id
         WHERE m.enabled=true AND p.enabled=true AND p.protocol='apimart' AND p.encrypted_credentials IS NOT NULL AND 'video'=ANY(m.capabilities)
         ORDER BY m.name,m.id`,
      );
      response.json({ models: result.rows.flatMap((model) => isSupportedVideoModelId(model.modelId)
        ? [{ ...model, capability: getVideoModelCapability(model.modelId) }] : []) });
    } catch (error) { next(error); }
  });
  return router;
}
