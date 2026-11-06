import { apiMartImageModel } from "./apimart-image";

const imageOperations = new Set(["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"]);

/** Ordinary images only; masks and annotation layers have separate provider fields. */
export function promptImageReferenceLimit(target: { modelId: string; protocol: string; workflowConfigId?: string | null }) {
  if (target.workflowConfigId) return /^(?:gpt-image-2|gpt-image-2-ext)$/.test(target.modelId) ? 16 : 8;
  if (target.protocol === "apimart") {
    const model = apiMartImageModel(target.modelId);
    if (model === "mai-image-2.6-flash") return 5;
    if (model === "grok-imagine-image-2.0") return 3;
    if (model === "midjourney-blend") return 4;
    if (model === "gpt-image-2") return 15;
    if (model === "gemini-3.1-flash-image-preview") return 14;
    // GPT2.5/2.6 support 16; Nano2.1 and MJ use the workbench's bounded limit.
    if (model) return 16;
  }
  if (target.protocol === "openai" && /^gpt-image-(?:1|1-mini|1\.5|2|2\.5-flare|2\.5-sunburst)$/.test(target.modelId)) return 16;
  return 8;
}

/** Each explicit image task produces one result; independent tasks/concurrency remain allowed. */
export function singleImageTaskParameters(operationType: string, parameters: Record<string, unknown> = {}) {
  if (!imageOperations.has(operationType)) return parameters;
  return { ...parameters, n: 1, count: 1 };
}
