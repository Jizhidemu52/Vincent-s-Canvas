import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import type { Database } from "./db";

export const DEFAULT_CHAT_MODEL_TOOL_KEY = "gpt-chat";
export const INITIAL_CHAT_MODEL_ID = "claude-sonnet-5-5";

const inheritedModelFields = [
  "modelName", "modelId", "modelCreditCost", "modelRmbCost", "modelEnabled",
  "providerId", "providerName", "protocol", "baseUrl", "providerEnabled", "hasCredentials",
  "workflowConfigId", "workflowName", "workflowEnabled",
] as const;

/** Model ownership is shared; a canvas chat's availability, price and version stay independent. */
export function applyDefaultChatModel<T extends { toolKey: string; modelConfigId?: unknown }>(tools: T[]): T[] {
  const source = tools.find(tool => tool.toolKey === DEFAULT_CHAT_MODEL_TOOL_KEY) as (T & Record<string, unknown>) | undefined;
  return tools.map(tool => {
    if (tool.toolKey !== "canvas-chat") return tool;
    const inherited = Object.fromEntries(inheritedModelFields
      .filter(field => field in tool || (source && field in source))
      .map(field => [field, source?.[field] ?? null]));
    return { ...tool, ...inherited, modelConfigId: source?.modelConfigId ?? null };
  });
}

/** First-run default only: a later explicit selection or clearing is never overwritten. */
export async function initializeDefaultChatModel(db: Pick<Database, "query">) {
  await db.query(`INSERT INTO tool_api_configurations(tool_key,model_config_id,enabled)
    SELECT 'gpt-chat',id,true FROM model_configs WHERE provider_id=$1 AND model_id=$2
    ON CONFLICT(tool_key) DO UPDATE SET model_config_id=EXCLUDED.model_config_id,
      configuration_version=tool_api_configurations.configuration_version+1,updated_at=now()
    WHERE tool_api_configurations.model_config_id IS NULL AND tool_api_configurations.updated_by IS NULL
      AND tool_api_configurations.configuration_version=1`, [MARK_IMAGE_PROVIDER_ID, INITIAL_CHAT_MODEL_ID]);
}
