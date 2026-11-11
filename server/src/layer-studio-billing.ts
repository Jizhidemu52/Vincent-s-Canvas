import type { PoolClient } from "pg";
import { layerStudioTaskOptions, LAYER_STUDIO_RATIOS } from "../../shared/layer-studio-options";
import { BillingError, loadTaskPriceSnapshot, settleReservation, type PriceSnapshot } from "./billing";
import type { Database } from "./db";
import { withTransaction } from "./db-transaction";
import type { ToolConfiguration } from "./tool-configuration";
import { LAYER_STUDIO_MODEL_ID } from "./layer-studio-policy";

export type LayerStudioRates = { inputRmb: number; lowOutputRmb: number; highOutputRmb: number; version: number };
export type LayerStudioCostSnapshot = LayerStudioRates & {
  schema: 1;
  currency: "CNY";
  sourceCount: number;
  maximumOutputs: number;
  prechargeBand: "low" | "high";
  estimatedPrecharge: number;
  providerCharge: "unverified";
  settledOutputCount?: number;
  settledEstimate?: number;
  actualOutputPixels?: number[];
};
const money = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
export function layerStudioCostEstimate(parameters: Record<string, unknown>, sourceCount: number, rates: LayerStudioRates): LayerStudioCostSnapshot {
  let options: ReturnType<typeof layerStudioTaskOptions>;
  try { options = layerStudioTaskOptions(parameters, "cost preflight", sourceCount); }
  catch { throw new BillingError("INVALID_LAYER_PARAMETERS", "图层工作区参数或参考图数量不符合要求"); }
  if (!Number.isInteger(rates.version) || rates.version < 1 || !Number.isFinite(rates.inputRmb) || rates.inputRmb < 0
    || !Number.isFinite(rates.lowOutputRmb) || rates.lowOutputRmb <= 0 || !Number.isFinite(rates.highOutputRmb)
    || rates.highOutputRmb < rates.lowOutputRmb || Math.max(rates.inputRmb, rates.highOutputRmb) > 1000) {
    throw new BillingError("PRICE_NOT_CONFIGURED", "图层工作区费用尚未完整配置");
  }
  const layers = options.layer_decomposition === true;
  const size = options.size ?? (layers ? options.resolution ?? "auto" : "2K");
  const isRatio = (LAYER_STUDIO_RATIOS as readonly string[]).includes(size.replace("x", ":"));
  const tier = isRatio ? options.resolution ?? "2K" : size;
  const exact = !isRatio ? /^([1-9]\d*)x([1-9]\d*)$/.exec(size) : null;
  const low = exact ? Number(exact[1]) * Number(exact[2]) <= 2_610_000 : tier === "1K" || tier === "1.5K";
  const maximumOutputs = layers ? options.layer_decomposition_options?.max_images ?? 30 : 1;
  return { ...rates, schema: 1, currency: "CNY", sourceCount, maximumOutputs, prechargeBand: low ? "low" : "high",
    estimatedPrecharge: money(sourceCount * rates.inputRmb + maximumOutputs * (low ? rates.lowOutputRmb : rates.highOutputRmb)),
    providerCharge: "unverified" };
}

export function settleLayerStudioCost(snapshot: LayerStudioCostSnapshot, outputs: Array<{ width: number; height: number }>): LayerStudioCostSnapshot {
  if (snapshot.schema !== 1 || snapshot.currency !== "CNY" || outputs.length < 1 || outputs.length > snapshot.maximumOutputs
    || outputs.length > 100 || outputs.some(item => !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)
      || item.width < 1 || item.height < 1 || !Number.isSafeInteger(item.width * item.height))) {
    throw new BillingError("INVALID_OUTPUT_QUANTITY", "图层结果数量或原图尺寸不完整，不能结算");
  }
  const actualOutputPixels = outputs.map(item => item.width * item.height);
  const outputCost = actualOutputPixels.reduce((sum, pixels) => sum + (pixels <= 2_610_000 ? snapshot.lowOutputRmb : snapshot.highOutputRmb), 0);
  return { ...snapshot, settledOutputCount: outputs.length, actualOutputPixels,
    settledEstimate: money(snapshot.sourceCount * snapshot.inputRmb + outputCost), providerCharge: "unverified" };
}

export async function loadLayerStudioPriceSnapshot(client: Pick<Database, "query">, input: {
  modelConfigId: string; toolConfiguration: ToolConfiguration; parameters: Record<string, unknown>; sourceCount: number; creditsEnabled?: boolean;
}): Promise<PriceSnapshot> {
  const result = await client.query<LayerStudioRates>(
    `SELECT p.input_rmb::float8 AS "inputRmb",p.low_output_rmb::float8 AS "lowOutputRmb",
       p.high_output_rmb::float8 AS "highOutputRmb",p.version
       FROM layer_studio_prices p JOIN model_configs m ON m.id=p.model_config_id JOIN providers v ON v.id=m.provider_id
       WHERE p.model_config_id=$1 AND m.model_id=$2 AND m.workflow_config_id IS NULL AND v.protocol='apimart'`,
    [input.modelConfigId, LAYER_STUDIO_MODEL_ID]);
  if (!result.rows[0]) throw new BillingError("PRICE_NOT_CONFIGURED", "图层工作区费用尚未配置；需同时确认输入图及两档输出单价");
  const layerStudioCost = layerStudioCostEstimate(input.parameters, input.sourceCount, result.rows[0]);
  const base = await loadTaskPriceSnapshot(client, { operationType: "image_generation", modelConfigId: input.modelConfigId,
    toolConfiguration: input.toolConfiguration, quantity: 1, creditsEnabled: input.creditsEnabled });
  // Employee credits remain the configured once-per-task price. This estimate is
  // provider cost accounting, not proof that the provider charged/refunded money.
  return { ...base, imageCost: undefined, layerStudioCost, totalRmb: layerStudioCost.estimatedPrecharge };
}

export async function settleLayerStudioReservation(db: Database, requestId: string,
  outputs: Array<{ width: number; height: number }>, existingClient?: PoolClient) {
  const settle = async (client: PoolClient) => {
    const result = await client.query<{ id: string; status: string; price_snapshot: PriceSnapshot }>(
      "SELECT id,status,price_snapshot FROM credit_reservations WHERE request_id=$1 FOR UPDATE", [requestId]);
    const reservation = result.rows[0];
    if (!reservation) throw new BillingError("RESERVATION_NOT_FOUND", "额度冻结记录不存在");
    if (reservation.status !== "held") return { status: reservation.status, duplicate: true };
    if (!reservation.price_snapshot.layerStudioCost) throw new BillingError("PRICE_NOT_CONFIGURED", "原任务缺少完整费用快照，不能按当前费率重算");
    const cost = settleLayerStudioCost(reservation.price_snapshot.layerStudioCost, outputs);
    const snapshot: PriceSnapshot = { ...reservation.price_snapshot, layerStudioCost: cost,
      settledQuantity: outputs.length, settledTotalRmb: cost.settledEstimate };
    await client.query("UPDATE credit_reservations SET rmb_cost=$1,price_snapshot=$2 WHERE id=$3", [cost.settledEstimate, snapshot, reservation.id]);
    await client.query("UPDATE tasks SET rmb_cost=$1,updated_at=now() WHERE request_id=$2", [cost.settledEstimate, requestId]);
    return settleReservation(db, requestId, "capture", undefined, client);
  };
  return existingClient ? settle(existingClient) : withTransaction(db, settle);
}
