import type { ImageModelDefaults } from "../../shared/image-generation-defaults";
import type { Database } from "./db";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { isImageModel, isSelectableCreativeModel } from "./model-presentation";

export type ImageGenerationDefaults = {
  defaultModelConfigId: string | null;
  modelOptions: Record<string, ImageModelDefaults>;
};

export async function listImageDefaultCandidates(db: Pick<Database, "query">, lock = false) {
  const result = await db.query(`SELECT m.id,m.name,m.model_id AS "modelId",m.capabilities,m.enabled,m.workflow_config_id AS "workflowConfigId",
    m.credit_cost AS "creditCost",m.rmb_cost::float8 AS "rmbCost",p.id AS "providerId",p.protocol,p.enabled AS "providerEnabled",
    p.name AS "providerName",p.base_url AS "providerBaseUrl" FROM model_configs m JOIN providers p ON p.id=m.provider_id
    WHERE m.enabled AND p.enabled AND m.workflow_config_id IS NULL ORDER BY m.name,m.id${lock ? " FOR SHARE OF m,p" : ""}`);
  return result.rows.filter(isGeneralImageDefaultCandidate);
}

export function isGeneralImageDefaultCandidate(model: Record<string, unknown>) {
  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
  return !model.workflowConfigId && model.enabled !== false && model.providerEnabled !== false
    && (model.protocol === "apimart" || model.protocol === "openai") && model.modelId !== "seedream-5-5"
    && isImageModel(model) && capabilities.includes("generate") && capabilities.includes("edit")
    && isSelectableCreativeModel(model);
}

export async function readImageGenerationDefaults(db: Pick<Database, "query">): Promise<ImageGenerationDefaults> {
  const result = await db.query<ImageGenerationDefaults>(
    'SELECT default_model_config_id AS "defaultModelConfigId",model_options AS "modelOptions" FROM image_generation_defaults WHERE singleton=true',
  );
  return result.rows[0] ?? { defaultModelConfigId: null, modelOptions: {} };
}

export function getDefaultImageModelId(models: Array<Record<string, unknown>>, configuredId: string | null) {
  const eligible = models.filter(isGeneralImageDefaultCandidate);
  const selected = eligible.find(model => model.id === configuredId)
    ?? eligible.find(model => model.providerId === MARK_IMAGE_PROVIDER_ID && model.modelId === "gpt-image-2.6-flare");
  return selected ? String(selected.id) : null;
}
