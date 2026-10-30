import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { MARK_PLATFORM_MODELS, MARK_IMAGE_PROVIDER_ID, MARK_IMAGE_PROVIDER_NAME } from "../../../shared/mark-image-models";
import { writeAudit } from "../audit";
import { isPublicHttpsUrl } from "../apimart-upload";
import type { AppConfig } from "../config";
import type { Database } from "../db";
import { encryptSecret } from "../security";
import type { AuthenticatedRequest } from "../types";
import { initializeDefaultChatModel } from "../chat-model-policy";
import { getApimartImageCost } from "../../../shared/apimart-image-costs";

const modelInput = z.object({
  modelId: z.string(), enabled: z.boolean(), creditCost: z.number().int().nonnegative(),
  rmbCost: z.number().finite().nonnegative(), concurrencyLimit: z.number().int().min(1).max(100),
}).strict();
const configurationInput = z.object({
  baseUrl: z.string().trim().transform(value => value.replace(/\/+$/, "")).refine(value => {
    if (!isPublicHttpsUrl(value)) return false;
    const url = new URL(value);
    return url.pathname.endsWith("/v1") && !url.search && !url.hash;
  }, "API 地址须为公开 HTTPS 地址并以 /v1 结尾，不含查询参数"),
  apiKey: z.string().trim().max(10_000).optional(), enabled: z.boolean(),
  models: z.array(modelInput).length(MARK_PLATFORM_MODELS.length).refine(models =>
    new Set(models.map(model => model.modelId)).size === MARK_PLATFORM_MODELS.length
      && models.every(model => MARK_PLATFORM_MODELS.some(preset => preset.modelId === model.modelId)),
  "须完整配置 APIMart 的六个图片模型、MJ Blend、两个文字模型和视频模型，不能重复或遗漏"),
}).strict();

const providerSelect = `id,name,protocol,base_url AS "baseUrl",enabled,(encrypted_credentials IS NOT NULL) AS "hasCredentials"`;
async function readConfiguration(db: Database | PoolClient) {
  const provider = (await db.query(`SELECT ${providerSelect} FROM providers WHERE id=$1`, [MARK_IMAGE_PROVIDER_ID])).rows[0] || null;
  const models = (await db.query(`SELECT id,name,model_id AS "modelId",enabled,credit_cost AS "creditCost",rmb_cost::float8 AS "rmbCost",concurrency_limit AS "concurrencyLimit"
    FROM model_configs WHERE provider_id=$1 AND model_id=ANY($2::text[]) ORDER BY model_id`,
  [MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS.map(model => model.modelId)])).rows;
  return { provider, models: models.map(model => {
    const imageCost = getApimartImageCost(MARK_IMAGE_PROVIDER_ID, model.modelId);
    return imageCost ? { ...model, imageCost, rmbCost: imageCost.rmbPerImage } : model;
  }) };
}

/** Mounted inside the existing super_admin-only model configuration router. */
export function createMarkImageProviderRouter(db: Database, config: AppConfig) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try { response.json(await readConfiguration(db)); } catch (error) { next(error); }
  });
  router.put("/", async (request, response, next) => {
    let client: PoolClient | undefined;
    try {
      const input = configurationInput.parse(request.body);
      const actor = (request as AuthenticatedRequest).auth;
      if (input.apiKey && !config.PROVIDER_ENCRYPTION_KEY) {
        response.status(503).json({ error: "SECRET_KEY_NOT_CONFIGURED", message: "服务器尚未配置 Provider 凭据加密密钥" }); return;
      }
      client = await db.connect();
      await client.query("BEGIN");
      // Serialize both first creation and subsequent updates without introducing a second credential store.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MARK_IMAGE_PROVIDER_ID]);
      const current = (await client.query(`SELECT ${providerSelect} FROM providers WHERE id=$1 FOR UPDATE`, [MARK_IMAGE_PROVIDER_ID])).rows[0];
      if (!input.apiKey && (!current?.hasCredentials || current.baseUrl !== input.baseUrl)) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "API_KEY_REQUIRED", message: current?.hasCredentials
          ? "更换 API 地址时请同时填写新地址对应的 API Key" : "首次保存请填写 APIMart 平台的 API Key" }); return;
      }
      const encrypted = input.apiKey ? encryptSecret(JSON.stringify({ apiKey: input.apiKey }), config.PROVIDER_ENCRYPTION_KEY!) : null;
      await client.query(`INSERT INTO providers(id,name,protocol,base_url,enabled,encrypted_credentials,created_by)
        VALUES($1,$2,'apimart',$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,protocol='apimart',base_url=EXCLUDED.base_url,
        enabled=EXCLUDED.enabled,encrypted_credentials=COALESCE(EXCLUDED.encrypted_credentials,providers.encrypted_credentials),updated_at=now()`,
      [MARK_IMAGE_PROVIDER_ID, MARK_IMAGE_PROVIDER_NAME, input.baseUrl, input.enabled, encrypted, actor.id]);
      for (const preset of MARK_PLATFORM_MODELS) {
        const model = input.models.find(item => item.modelId === preset.modelId)!;
        await client.query(`INSERT INTO model_configs(provider_id,name,model_id,capabilities,credit_cost,rmb_cost,concurrency_limit,enabled,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_id,model_id) DO UPDATE SET name=EXCLUDED.name,capabilities=EXCLUDED.capabilities,
          workflow_config_id=NULL,replacement_model_config_id=NULL,credit_cost=EXCLUDED.credit_cost,rmb_cost=EXCLUDED.rmb_cost,
          concurrency_limit=EXCLUDED.concurrency_limit,enabled=EXCLUDED.enabled,updated_at=now()`,
        [MARK_IMAGE_PROVIDER_ID, preset.name, preset.modelId, [...preset.capabilities], model.creditCost,
          getApimartImageCost(MARK_IMAGE_PROVIDER_ID, preset.modelId)?.rmbPerImage ?? model.rmbCost, model.concurrencyLimit, model.enabled, actor.id]);
      }
      await initializeDefaultChatModel(client);
      await writeAudit(client, { actor, action: "mark_platform.configured", targetType: "provider", targetId: MARK_IMAGE_PROVIDER_ID,
        result: "success", detail: { enabled: input.enabled, credentialsChanged: Boolean(input.apiKey), modelIds: input.models.map(model => model.modelId) }, ip: request.ip });
      const result = await readConfiguration(client);
      await client.query("COMMIT");
      response.json(result);
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      next(error);
    } finally { client?.release(); }
  });
  return router;
}
