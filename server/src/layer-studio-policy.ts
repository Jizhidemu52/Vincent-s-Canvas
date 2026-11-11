import { LAYER_STUDIO_TOOL } from "../../shared/layer-studio";

/** Provider identity is intentionally server-side, never a creation-page label. */
export const LAYER_STUDIO_MODEL_ID = "seedream-5-5";

export function isLayerStudioModel(model: { modelId?: unknown; protocol?: unknown; workflowConfigId?: unknown }) {
  return model.modelId === LAYER_STUDIO_MODEL_ID && model.protocol === "apimart" && !model.workflowConfigId;
}

export function layerStudioBindingValid(toolKey: string, model: { modelId?: unknown; protocol?: unknown; workflowConfigId?: unknown }) {
  return toolKey === LAYER_STUDIO_TOOL ? isLayerStudioModel(model) : model.modelId !== LAYER_STUDIO_MODEL_ID;
}
