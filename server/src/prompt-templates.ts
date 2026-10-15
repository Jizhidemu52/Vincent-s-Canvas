import { z } from "zod";

import { calculatePrice, modelSupportsOperation, type PriceSnapshot } from "./billing";
import type { Database } from "./db";
import { readToolConfiguration, type ToolConfiguration } from "./tool-configuration";
import { getToolDefinition, resolveToolKey } from "../../shared/feature-catalog";
import { isModuleEnabled } from "./module-flags";

export const promptTargetTools = [
  "image-generation", "detail-enhance", "image-edit", "angle-control",
  "batch-edit", "seamless-stitch", "video", "canvas",
] as const;

export type PromptTargetTool = (typeof promptTargetTools)[number];

const targetOperations: Record<PromptTargetTool, string> = {
  "image-generation": "image_generation",
  "detail-enhance": "upscale",
  "image-edit": "inpaint",
  "angle-control": "inpaint",
  "batch-edit": "batch_image",
  "seamless-stitch": "seamless_stitch",
  video: "video_generation",
  canvas: "image_generation",
};

const jsonRecord = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (JSON.stringify(value).length > 20_000) context.addIssue({ code: "custom", message: "参数快照不能超过 20000 个字符" });
});

export const promptSnapshotSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20_000),
  targetTool: z.enum(promptTargetTools),
  modelConfigId: z.string().uuid().nullable().optional(),
  parameters: jsonRecord.default({}),
  referenceAssetIds: z.array(z.string().uuid()).max(20).default([]),
  category: z.string().trim().max(80).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  notes: z.string().trim().max(2_000).default(""),
  sourceTaskId: z.string().uuid().nullable().optional(),
  sourceAssetId: z.string().uuid().nullable().optional(),
}).transform((value) => ({
  ...value,
  tags: [...new Set(value.tags)],
  referenceAssetIds: [...new Set(value.referenceAssetIds)],
}));

export type PromptSnapshotInput = z.input<typeof promptSnapshotSchema>;
export type PromptSnapshot = z.output<typeof promptSnapshotSchema>;

export type PromptModelCandidate = {
  id: string;
  name: string;
  modelId: string;
  capabilities: string[];
  creditCost: number;
  rmbCost: number;
  enabled: boolean;
  providerEnabled: boolean;
  workflowConfigId?: string | null;
  workflowEnabled?: boolean | null;
  replacementModelConfigId: string | null;
};

export type PromptPriceRule = { operationType: string; credits: number; rmbCost: number; version: number };

export function operationForPromptTool(tool: PromptTargetTool) {
  return targetOperations[tool];
}

export function quantityFromParameters(parameters: Record<string, unknown>) {
  const value = parameters.quantity ?? parameters.count;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : 1;
}

export function validateReplacementSelection(modelId: string, replacementId: string | null, ancestorIds: string[] = []) {
  if (!replacementId) return true;
  return replacementId !== modelId && !ancestorIds.includes(replacementId);
}

export function resolvePromptModel(
  historicalModelConfigId: string | null | undefined,
  operationType: string,
  models: PromptModelCandidate[],
) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const historical = historicalModelConfigId ? byId.get(historicalModelConfigId) ?? null : null;
  const isUsable = (model: PromptModelCandidate | null | undefined) => Boolean(model?.enabled && model.providerEnabled && (!model.workflowConfigId || model.workflowEnabled) && modelSupportsOperation(operationType, model.capabilities));
  if (isUsable(historical)) return { selected: historical, historical, modelChanged: false, reason: null, alternatives: [] as PromptModelCandidate[] };

  const visited = new Set<string>();
  let cursor = historical;
  while (cursor?.replacementModelConfigId && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const replacement = byId.get(cursor.replacementModelConfigId) ?? null;
    if (isUsable(replacement)) {
      return { selected: replacement, historical, modelChanged: true, reason: "replacement", alternatives: [] as PromptModelCandidate[] };
    }
    cursor = replacement;
  }
  const alternatives = models.filter(isUsable).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return {
    selected: null,
    historical,
    modelChanged: Boolean(historicalModelConfigId),
    reason: historicalModelConfigId ? (visited.size ? "replacement_unavailable" : "model_unavailable") : "model_required",
    alternatives,
  };
}

export function pricePromptModel(model: PromptModelCandidate, rule: PromptPriceRule, quantity: number, configuration?: ToolConfiguration): PriceSnapshot {
  return calculatePrice({
    ...(configuration ? { toolKey: configuration.toolKey, configurationVersion: configuration.configurationVersion, creditCostOverride: configuration.creditCostOverride, rmbCostOverride: configuration.rmbCostOverride } : {}),
    operationType: rule.operationType,
    operationCredits: rule.credits,
    operationRmb: rule.rmbCost,
    modelId: model.id,
    modelCredits: model.creditCost,
    modelRmb: model.rmbCost,
    quantity,
    priceVersion: rule.version,
  });
}

export async function resolveCurrentPromptPricing(
  db: Database,
  input: { historicalModelConfigId?: string | null; targetTool: PromptTargetTool; parameters: Record<string, unknown> },
) {
  const operationType = operationForPromptTool(input.targetTool);
  const source = typeof input.parameters.toolKey === "string" ? input.parameters.toolKey : typeof input.parameters.tool === "string" ? input.parameters.tool : input.targetTool === "batch-edit" ? "canvas-batch" : input.targetTool === "canvas" ? "canvas-image" : input.targetTool;
  const toolKey = resolveToolKey(operationType, source);
  const configuration = toolKey ? await readToolConfiguration(db, toolKey) : undefined;
  if (toolKey && (!(getToolDefinition(toolKey)!.operations as readonly string[]).includes(operationType) || !configuration?.enabled || !(await isModuleEnabled(db, toolKey)))) {
    return { operationType, modelChanged: false, reason: "tool_unavailable", selectedModel: null, estimate: null, alternatives: [] };
  }
  const [modelsResult, priceResult] = await Promise.all([
    db.query<PromptModelCandidate>(
      `SELECT m.id,m.name,m.model_id AS "modelId",m.capabilities,m.credit_cost AS "creditCost",
              m.rmb_cost::float8 AS "rmbCost",m.enabled,p.enabled AS "providerEnabled",
              m.replacement_model_config_id AS "replacementModelConfigId",m.workflow_config_id AS "workflowConfigId",w.enabled AS "workflowEnabled"
         FROM model_configs m JOIN providers p ON p.id=m.provider_id LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id`,
    ),
    db.query<{ credits: number; rmbCost: number; version: number }>(
      `SELECT credits,rmb_cost::float8 AS "rmbCost",version FROM pricing_rule_versions
        WHERE operation_type=$1 AND status='published'`, [operationType],
    ),
  ]);
  const rule = priceResult.rows[0] ?? (configuration?.creditCostOverride != null && configuration?.rmbCostOverride != null ? { credits: 0, rmbCost: 0, version: 0 } : undefined);
  if (!rule) return { operationType, modelChanged: false, reason: "price_unavailable", selectedModel: null, estimate: null, alternatives: [] };
  const resolution = resolvePromptModel(configuration?.modelConfigId ?? input.historicalModelConfigId, operationType, modelsResult.rows);
  if (configuration?.modelConfigId && resolution.selected?.id !== configuration.modelConfigId) {
    return { operationType, modelChanged: true, reason: "configured_model_unavailable", selectedModel: null, estimate: null, alternatives: [] };
  }
  const quantity = quantityFromParameters(input.parameters);
  return {
    operationType,
    modelChanged: resolution.modelChanged || Boolean(configuration?.modelConfigId && configuration.modelConfigId !== input.historicalModelConfigId),
    reason: resolution.reason,
    selectedModel: resolution.selected,
    estimate: resolution.selected ? pricePromptModel(resolution.selected, { ...rule, operationType }, quantity, configuration) : null,
    alternatives: resolution.alternatives.map((model) => ({ model, estimate: pricePromptModel(model, { ...rule, operationType }, quantity, configuration) })),
  };
}

export async function assertValidModelReplacement(db: Database, modelId: string, replacementId: string | null | undefined) {
  if (!replacementId) return;
  const result = await db.query<{ id: string; replacementModelConfigId: string | null }>(
    `SELECT id,replacement_model_config_id AS "replacementModelConfigId" FROM model_configs`,
  );
  const byId = new Map(result.rows.map((model) => [model.id, model.replacementModelConfigId]));
  if (!byId.has(replacementId)) throw new PromptTemplateError("INVALID_MODEL_REPLACEMENT", "替代模型不存在", 400);
  const visited = new Set<string>();
  let cursor: string | null = replacementId;
  while (cursor) {
    if (cursor === modelId || visited.has(cursor)) throw new PromptTemplateError("INVALID_MODEL_REPLACEMENT", "替代模型不能形成循环", 400);
    visited.add(cursor);
    cursor = byId.get(cursor) ?? null;
  }
}

export class PromptTemplateError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
