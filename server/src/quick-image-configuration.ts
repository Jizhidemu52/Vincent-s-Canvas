import { z } from "zod";
import type { AdminQuickImageConfiguration, QuickImageConfigurationInput, QuickImageEligibleModel } from "../../shared/quick-image-configuration";
import { isQuickImageAction, quickImageModelId, type QuickImageAction } from "../../shared/quick-image-tools";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { apiMartImageModel, preflightApiMartImageRequest } from "./apimart-image";
import type { Database } from "./db";
import { assertQuickImageSelectionPrompt, prepareQuickImageTask, QUICK_IMAGE_SNAPSHOT, quickImageDefaultParameters, quickImageDefaultPrompts, type QuickImageInput, type QuickImageSnapshot } from "./quick-image-tools";
import { ToolConfigurationError } from "./tool-configuration";

export const quickImageActions = ["remove-background", "hd-upscale", "item-extract"] as const;
export const quickImageActionSchema = z.enum(quickImageActions);
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
export const quickImageConfigurationSchema = z.object({ modelConfigId: z.string().uuid(), prompt: z.string().trim().min(1).max(4000),
  parameters: z.record(z.string(), scalar).refine(value => JSON.stringify(value).length <= 4000, "参数 JSON 不能超过 4000 个字符") }).strict();
export const quickImageConfigurationUpdateSchema = quickImageConfigurationSchema.extend({ expectedVersion: z.number().int().min(0) }).strict();
export const quickImageConfigurationTestSchema = z.object({ requestId: z.string().min(8).max(200), sourceUrl: z.string().max(2000), configuration: quickImageConfigurationSchema }).strict();

type Model = QuickImageEligibleModel & { enabled: boolean; providerEnabled: boolean; providerId: string; workflowConfigId: string | null };
const modelSelect = `m.id,m.name,m.model_id AS "modelId",m.capabilities,m.enabled,m.workflow_config_id AS "workflowConfigId",
  p.id AS "providerId",p.name AS "providerName",p.protocol,p.enabled AS "providerEnabled"`;

export function isQuickImageEligibleModel(model: { modelId: string; protocol: string; enabled?: boolean; providerEnabled?: boolean; workflowConfigId?: unknown; capabilities: string[] }) {
  const kind = apiMartImageModel(model.modelId);
  return model.enabled !== false && model.providerEnabled !== false && model.protocol === "apimart" && !model.workflowConfigId
    && model.capabilities.includes("edit") && Boolean(kind && !kind.startsWith("midjourney"));
}

/** Model-specific allowlists reject silently ignored adapter fields as well as URL/identity injection. */
export function validateQuickImageConfiguration(action: QuickImageAction, raw: QuickImageConfigurationInput, model: { modelId: string; protocol: string; capabilities: string[]; enabled?: boolean; providerEnabled?: boolean; workflowConfigId?: unknown }) {
  const input = quickImageConfigurationSchema.parse(raw);
  if (action === "remove-background") assertQuickImageSelectionPrompt(input.prompt);
  if (!isQuickImageEligibleModel(model)) throw new ToolConfigurationError("QUICK_IMAGE_MODEL_UNSUPPORTED", "请选择已启用、支持单图编辑的 APIMart 标准图片模型");
  const kind = apiMartImageModel(model.modelId)!;
  const allowed = kind === "mai-image-2.6-flash" ? ["web_grounding"]
    : kind === "grok-imagine-image-2.0" ? ["size", "aspect_ratio", "resolution", "nsfw_check"]
    : kind === "gemini-nano-banana-2.1" ? ["size", "resolution"]
    : kind.startsWith("gpt-image-2.5-") || kind.startsWith("gpt-image-2.6-")
      ? ["size", "resolution", "quality", "background", "output_format", "output_compression", "moderation", ...(kind.startsWith("gpt-image-2.6-") ? ["complexity"] : [])]
      : kind === "gpt-image-2" ? ["size", "resolution", "nsfw_check", "official_fallback"]
        : ["size", "resolution", "nsfw_check", "official_fallback", "officialFallback", "google_search", "googleSearch", "google_image_search", "googleImageSearch"];
  for (const key of Object.keys(input.parameters)) if (!allowed.includes(key)) throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", `当前模型不支持一键工具参数 ${key}`);
  const booleans = new Set(["web_grounding", "nsfw_check", "official_fallback", "officialFallback", "google_search", "googleSearch", "google_image_search", "googleImageSearch"]);
  for (const [key, value] of Object.entries(input.parameters)) {
    const expected = booleans.has(key) ? "boolean" : key === "output_compression" ? "number" : "string";
    if (typeof value !== expected || expected === "string" && !String(value).trim()) throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", `参数 ${key} 类型或值无效`);
  }
  if (input.parameters.output_format === "gif" || input.parameters.output_format === "svg") throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", "一键图片编辑仅支持静态 PNG、JPEG 或 WebP");
  if (action === "remove-background" && input.parameters.background === "transparent") throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", "去背景使用灰阶蒙版后合成原图，不接受透明蒙版输出参数");
  if (action === "item-extract" && input.parameters.background === "transparent") throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", "提取产品图输出白底商品图，不接受透明背景参数");
  try {
    preflightApiMartImageRequest({ modelId: model.modelId, prompt: input.prompt, parameters: { ...input.parameters, n: 1 }, sourceImages: ["https://owned-reference.invalid/source.png"] });
  } catch (error) { throw new ToolConfigurationError("QUICK_IMAGE_PARAMETER_INVALID", error instanceof Error ? error.message : "模型参数不正确"); }
  return input;
}

export async function readQuickImageModels(db: Pick<Database, "query">): Promise<QuickImageEligibleModel[]> {
  const rows = (await db.query<Model>(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id
    WHERE m.enabled=true AND p.enabled=true AND p.protocol='apimart' AND m.workflow_config_id IS NULL ORDER BY m.name,m.id`)).rows;
  return rows.filter(isQuickImageEligibleModel).map(({ id, name, modelId, providerName, protocol, capabilities }) => ({ id, name, modelId, providerName, protocol, capabilities }));
}

export async function readQuickImageModel(db: Pick<Database, "query">, modelConfigId: string) {
  const model = (await db.query<Model>(`SELECT ${modelSelect} FROM model_configs m JOIN providers p ON p.id=m.provider_id WHERE m.id=$1`, [modelConfigId])).rows[0];
  if (!model || !model.enabled || !model.providerEnabled) throw new ToolConfigurationError("MODEL_DISABLED", "模型或 Provider 不存在或未启用");
  return model;
}

export async function readQuickImageConfiguration(db: Pick<Database, "query">, action: QuickImageAction): Promise<AdminQuickImageConfiguration> {
  const row = (await db.query<AdminQuickImageConfiguration>(`SELECT q.action,q.model_config_id AS "modelConfigId",m.model_id AS "modelId",m.name AS "modelName",
    q.prompt,q.parameters,q.configuration_version AS "configurationVersion",false AS "isDefault"
    FROM quick_image_configurations q JOIN model_configs m ON m.id=q.model_config_id WHERE q.action=$1`, [action])).rows[0];
  if (row) return row;
  const model = (await db.query<{ id: string; modelId: string; name: string }>(`SELECT m.id,m.model_id AS "modelId",m.name FROM model_configs m
    JOIN providers p ON p.id=m.provider_id WHERE m.provider_id=$1 AND m.model_id=$2 AND p.protocol='apimart' LIMIT 1`, [MARK_IMAGE_PROVIDER_ID, quickImageModelId(action)])).rows[0];
  return { action, modelConfigId: model?.id ?? null, modelId: model?.modelId ?? null, modelName: model?.name ?? null,
    prompt: quickImageDefaultPrompts[action], parameters: { ...quickImageDefaultParameters[action] }, configurationVersion: 0, isDefault: true };
}

export async function prepareConfiguredQuickImageTask<T extends QuickImageInput>(db: Pick<Database, "query">, input: T,
  draft?: QuickImageConfigurationInput): Promise<T & { [QUICK_IMAGE_SNAPSHOT]?: QuickImageSnapshot }> {
  const action = input.parameters?.quickImageAction;
  if (!isQuickImageAction(action)) return prepareQuickImageTask(input);
  if (input[QUICK_IMAGE_SNAPSHOT] && !draft) return input;
  const configuration = draft ? { ...draft, configurationVersion: 0 } : await readQuickImageConfiguration(db, action);
  if (!configuration.modelConfigId) throw new ToolConfigurationError("MODEL_DISABLED", "管理员尚未配置一键工具的可用模型");
  const model = await readQuickImageModel(db, configuration.modelConfigId);
  const validated = validateQuickImageConfiguration(action, { modelConfigId: configuration.modelConfigId, prompt: configuration.prompt, parameters: configuration.parameters }, model);
  const snapshot: QuickImageSnapshot = Object.freeze({ ...validated, action, modelId: model.modelId, parameters: Object.freeze({ ...validated.parameters }),
    configurationVersion: configuration.configurationVersion, ...(draft ? { adminTest: true } : {}) });
  return prepareQuickImageTask(input, snapshot);
}
