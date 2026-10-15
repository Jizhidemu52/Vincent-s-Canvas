import { getToolDefinition, resolveToolKey, type ToolKey } from "../../shared/feature-catalog";
import type { Database } from "./db";
import { modelSupportsOperation } from "./billing";
import { assertModuleEnabled } from "./module-flags";

export type ToolConfiguration = {
  toolKey: ToolKey;
  modelConfigId: string | null;
  enabled: boolean;
  creditCostOverride: number | null;
  rmbCostOverride: number | null;
  configurationVersion: number;
};

export class ToolConfigurationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

export function normalizeTaskTool(input: { operationType: string; toolKey?: string | null; parameters?: Record<string, unknown> }): ToolKey {
  const supplied = input.toolKey ?? (typeof input.parameters?.tool === "string" ? input.parameters.tool : undefined);
  const key = resolveToolKey(input.operationType, supplied);
  if (!key) throw new ToolConfigurationError("INVALID_TOOL_KEY", "未知功能板块，请刷新后重试");
  const definition = getToolDefinition(key)!;
  if (!(definition.operations as readonly string[]).includes(input.operationType)) {
    throw new ToolConfigurationError("TOOL_OPERATION_MISMATCH", "该功能板块不支持当前操作");
  }
  return key;
}

export async function readToolConfiguration(db: Pick<Database, "query">, toolKey: ToolKey): Promise<ToolConfiguration> {
  const result = await db.query<ToolConfiguration>(
    `SELECT tool_key AS "toolKey",model_config_id AS "modelConfigId",enabled,
      credit_cost_override AS "creditCostOverride",rmb_cost_override::float8 AS "rmbCostOverride",
      configuration_version AS "configurationVersion" FROM tool_api_configurations WHERE tool_key=$1`, [toolKey],
  );
  return result.rows[0] ?? { toolKey, modelConfigId: null, enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 0 };
}

/** Resolve once at submission; a configured binding never silently swaps stale client parameters. */
export async function resolveToolExecution(db: Pick<Database, "query">, input: {
  operationType: string; toolKey?: string | null; parameters?: Record<string, unknown>;
  modelConfigId?: string | null; modelId?: string | null;
}): Promise<ToolConfiguration & { modelConfigId: string }> {
  const toolKey = normalizeTaskTool(input);
  await assertModuleEnabled(db, toolKey);
  const configuration = await readToolConfiguration(db, toolKey);
  if (!configuration.enabled) throw new ToolConfigurationError("TOOL_DISABLED", "该功能的模型调用已停用", 403);
  const parent = getToolDefinition(toolKey)?.parent;
  if (parent && getToolDefinition(parent) && !(await readToolConfiguration(db, parent as ToolKey)).enabled) {
    throw new ToolConfigurationError("TOOL_DISABLED", "所属功能的模型调用已停用", 403);
  }
  const requested = input.modelConfigId ?? input.modelId;
  const selected = configuration.modelConfigId ?? requested;
  if (!selected) throw new ToolConfigurationError("MODEL_REQUIRED", "请先选择一个已启用的模型");
  const result = await db.query<{
    id: string; modelId: string; enabled: boolean; providerEnabled: boolean;
    workflowConfigId: string | null; workflowEnabled: boolean | null; capabilities: string[];
  }>(`SELECT m.id,m.model_id AS "modelId",m.enabled,p.enabled AS "providerEnabled",m.capabilities,
      m.workflow_config_id AS "workflowConfigId",w.enabled AS "workflowEnabled"
      FROM model_configs m JOIN providers p ON p.id=m.provider_id
      LEFT JOIN workflow_configs w ON w.id=m.workflow_config_id
      WHERE m.id::text=$1 OR m.model_id=$1 ORDER BY (m.id::text=$1) DESC LIMIT 1`, [selected]);
  const model = result.rows[0];
  if (!model || !model.enabled || !model.providerEnabled) throw new ToolConfigurationError("MODEL_DISABLED", "模型或 Provider 不存在或未启用");
  if (model.workflowConfigId && !model.workflowEnabled) throw new ToolConfigurationError("WORKFLOW_DISABLED", "模型工作流未启用");
  if (configuration.modelConfigId && requested && requested !== model.id && requested !== model.modelId) {
    throw new ToolConfigurationError("TOOL_MODEL_CHANGED", "管理员已更改该板块模型，请刷新模型配置和参数后重试", 409);
  }
  const definition = getToolDefinition(toolKey)!;
  if (!definition.capabilities.some((capability) => model.capabilities.includes(capability)) || !modelSupportsOperation(input.operationType, model.capabilities)) {
    throw new ToolConfigurationError("MODEL_CAPABILITY_MISMATCH", `所选模型不支持${definition.label}`);
  }
  return { ...configuration, modelConfigId: model.id };
}
