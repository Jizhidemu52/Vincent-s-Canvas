import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { MARK_IMAGE_PROVIDER_ID } from "../../../shared/mark-image-models";
import { writeAudit } from "../audit";
import type { Database } from "../db";
import { readFeaturedModelIds } from "../featured-models";
import { applyModelPresentation, isFeaturedModelCandidate, MAX_FEATURED_MODELS, presentAdminModel, resolveFeaturedModelIds } from "../model-presentation";
import type { AuthenticatedRequest } from "../types";

const inputSchema = z.object({ modelConfigIds: z.array(z.string().uuid()).max(MAX_FEATURED_MODELS)
  .refine(ids => new Set(ids).size === ids.length, "热门模型不能重复") }).strict();
const candidateSelect = `SELECT m.id,m.public_number AS "publicNumber",m.provider_id AS "providerId",p.name AS "providerName",p.protocol,
  p.enabled AS "providerEnabled",(p.encrypted_credentials IS NOT NULL) AS "hasCredentials",
  m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost",
  m.concurrency_limit AS "concurrencyLimit",m.enabled,m.created_at AS "createdAt",m.updated_at AS "updatedAt"
  FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.provider_id=$1 ORDER BY m.public_number NULLS LAST,m.name`;

function presentConfiguration(models: Array<Record<string, unknown>>, configuredIds: string[] | null) {
  const candidates = models.filter(isFeaturedModelCandidate);
  return {
    models: applyModelPresentation(candidates, configuredIds).sort((a, b) => a.displayOrder - b.displayOrder).map(presentAdminModel),
    featuredModelIds: resolveFeaturedModelIds(candidates, configuredIds),
    maxFeatured: MAX_FEATURED_MODELS,
  };
}

/** Mounted behind the model-configuration router's super_admin boundary. */
export function createFeaturedModelsRouter(db: Database) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try {
      const [models, configuredIds] = await Promise.all([
        db.query(candidateSelect, [MARK_IMAGE_PROVIDER_ID]), readFeaturedModelIds(db),
      ]);
      response.json(presentConfiguration(models.rows, configuredIds));
    } catch (error) { next(error); }
  });
  router.put("/", async (request, response, next) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "VALIDATION_ERROR", message: "请选择最多 5 个不重复的热门模型，并按展示顺序提交配置编号" }); return;
    }
    let client: PoolClient | undefined;
    try {
      const actor = (request as unknown as AuthenticatedRequest).auth;
      client = await db.connect();
      await client.query("BEGIN");
      // Serialize with the dedicated provider save; row locks also protect generic model/provider edits.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MARK_IMAGE_PROVIDER_ID]);
      const models = (await client.query(`${candidateSelect} FOR SHARE OF m,p`, [MARK_IMAGE_PROVIDER_ID])).rows;
      const eligibleIds = new Set(models.filter(model => isFeaturedModelCandidate(model) && model.enabled === true && model.providerEnabled === true).map(model => String(model.id)));
      if (parsed.data.modelConfigIds.some(id => !eligibleIds.has(id))) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "INVALID_FEATURED_MODEL", message: "热门模型只能选择已启用的 APIMart 平台出图模型；请先启用模型及其平台" }); return;
      }
      await client.query(`INSERT INTO model_presentation_settings(singleton,featured_model_ids,updated_by)
        VALUES(true,$1::uuid[],$2) ON CONFLICT(singleton) DO UPDATE SET featured_model_ids=EXCLUDED.featured_model_ids,
        updated_by=EXCLUDED.updated_by,updated_at=now()`, [parsed.data.modelConfigIds, actor.id]);
      await writeAudit(client, { actor, action: "featured_models.updated", targetType: "model_presentation", result: "success", detail: { modelConfigIds: parsed.data.modelConfigIds }, ip: request.ip });
      await client.query("COMMIT");
      response.json(presentConfiguration(models, parsed.data.modelConfigIds));
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      next(error);
    } finally { client?.release(); }
  });
  return router;
}
