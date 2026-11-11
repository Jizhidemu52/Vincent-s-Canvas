import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { Database } from "../db";
import type { AuthenticatedRequest } from "../types";
import { writeAudit } from "../audit";
import { withTransaction } from "../db-transaction";
import { resolveToolExecution, ToolConfigurationError } from "../tool-configuration";
import { BillingError } from "../billing";
import { loadLayerStudioPriceSnapshot } from "../layer-studio-billing";
import { isLayerStudioModel } from "../layer-studio-policy";

const estimateInput = z.object({ parameters: z.record(z.string(), z.unknown()), sourceCount: z.number().int().min(0).max(10) }).strict();
const exactMoney = (value: number) => Number(value.toFixed(6)) === value;
const rateInput = z.object({ inputRmb: z.number().finite().min(0).max(1000).refine(exactMoney, "单价最多保留6位小数"), lowOutputRmb: z.number().finite().positive().max(1000).refine(exactMoney, "单价最多保留6位小数"),
  highOutputRmb: z.number().finite().positive().max(1000).refine(exactMoney, "单价最多保留6位小数"), sourceNote: z.string().trim().min(1).max(500) }).strict()
  .refine(value => value.highOutputRmb >= value.lowOutputRmb, "高档单价不能低于低档单价");
const priceSelect = `model_config_id AS "modelConfigId",input_rmb::float8 AS "inputRmb",low_output_rmb::float8 AS "lowOutputRmb",
  high_output_rmb::float8 AS "highOutputRmb",source_note AS "sourceNote",version,updated_at AS "updatedAt"`;
const errors: ErrorRequestHandler = (error, _request, response, next) => {
  if (error instanceof BillingError) { response.status(error.code === "PRICE_NOT_CONFIGURED" ? 503 : 400).json({ error: error.code, message: error.message }); return; }
  if (error instanceof ToolConfigurationError) { response.status(error.status).json({ error: error.code, message: error.message }); return; }
  next(error);
};

/** This quote is read-only; it never submits, reserves credits or calls a provider. */
export function createLayerStudioRouter(db: Database, creditPolicy: boolean | (() => Promise<boolean>) = true) {
  const router = Router();
  router.post("/estimate", async (request, response, next) => {
    try {
      const input = estimateInput.parse(request.body);
      const execution = await resolveToolExecution(db, { operationType: "image_generation", toolKey: "layer-studio", parameters: input.parameters });
      const creditsEnabled = typeof creditPolicy === "function" ? await creditPolicy() : creditPolicy;
      const snapshot = await loadLayerStudioPriceSnapshot(db, { ...input, toolConfiguration: execution, modelConfigId: execution.modelConfigId, creditsEnabled });
      const cost = snapshot.layerStudioCost!;
      response.set("Cache-Control", "no-store").json({ estimate: { currency: "CNY", estimatedPrecharge: cost.estimatedPrecharge,
        maximumOutputs: cost.maximumOutputs, sourceCount: cost.sourceCount, priceVersion: cost.version,
        employeeCredits: snapshot.totalCredits, providerCharge: "unverified" } });
    } catch (error) { next(error); }
  });
  router.use(errors);
  return router;
}

/** Mounted only behind the existing super_admin model-configuration gate. */
export function createLayerStudioPricingRouter(db: Database) {
  const router = Router();
  router.get("/", async (_request, response, next) => {
    try { response.json({ prices: (await db.query(`SELECT ${priceSelect} FROM layer_studio_prices ORDER BY model_config_id`)).rows }); }
    catch (error) { next(error); }
  });
  router.put("/:modelConfigId", async (request, response, next) => {
    try {
      const modelConfigId = z.string().uuid().parse(request.params.modelConfigId);
      const input = rateInput.parse(request.body);
      const actor = (request as unknown as AuthenticatedRequest).auth;
      const price = await withTransaction(db, async client => {
        const model = (await client.query<{ modelId: string; protocol: string; workflowConfigId: string | null }>(
          `SELECT m.model_id AS "modelId",p.protocol,m.workflow_config_id AS "workflowConfigId"
             FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1 FOR UPDATE OF m`, [modelConfigId])).rows[0];
        if (!model || !isLayerStudioModel(model)) throw new ToolConfigurationError("TOOL_MODEL_MISMATCH", "所选模型不属于图层工作区");
        const saved = (await client.query(`INSERT INTO layer_studio_prices(model_config_id,input_rmb,low_output_rmb,high_output_rmb,source_note,updated_by)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(model_config_id) DO UPDATE SET input_rmb=EXCLUDED.input_rmb,
          low_output_rmb=EXCLUDED.low_output_rmb,high_output_rmb=EXCLUDED.high_output_rmb,source_note=EXCLUDED.source_note,
          version=layer_studio_prices.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING ${priceSelect}`,
          [modelConfigId, input.inputRmb, input.lowOutputRmb, input.highOutputRmb, input.sourceNote, actor.id])).rows[0];
        await writeAudit(client, { actor, action: "layer_studio.price_updated", targetType: "model", targetId: modelConfigId,
          result: "success", detail: { ...input, version: saved.version }, ip: request.ip });
        return saved;
      });
      response.json({ price });
    } catch (error) { next(error); }
  });
  router.use(errors);
  return router;
}
