import { LAYER_STUDIO_TOOL } from "../../shared/layer-studio";
import { getToolDefinition } from "../../shared/feature-catalog";

/** Provider identity remains server-side; the layer workspace has no model picker. */
export const LAYER_STUDIO_MODEL_ID = "seedream-5-5";

export function isLayerStudioModel(model: { modelId?: unknown; protocol?: unknown; workflowConfigId?: unknown }) {
  return model.modelId === LAYER_STUDIO_MODEL_ID && model.protocol === "apimart" && !model.workflowConfigId;
}

export function layerStudioBindingValid(toolKey: string, model: { modelId?: unknown; protocol?: unknown; workflowConfigId?: unknown }) {
  if (toolKey === LAYER_STUDIO_TOOL) return isLayerStudioModel(model);
  if (model.modelId !== LAYER_STUDIO_MODEL_ID) return true;
  return isLayerStudioModel(model) && toolKey !== "canvas-mask-edit" && toolKey !== "midjourney-blend"
    && Boolean(getToolDefinition(toolKey)?.operations.some(operation => ["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"].includes(operation)));
}
