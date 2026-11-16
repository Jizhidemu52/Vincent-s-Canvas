import { getToolDefinition } from "./feature-catalog";
import { validateLayerStudioOptions, type LayerStudioOptions } from "./layer-studio-options";

/** Ordinary image tasks share the verified Seedream adapter, not the layer UI contract. */
export function seedream55TaskOptions(parameters: Record<string, unknown>, prompt: string, sourceCount: number): LayerStudioOptions {
  const { tool, count, inputArchive, promptOptimization: _optimization, promptExclusions: _exclusions,
    imageAgentProfile: _agent, designRequirements: _requirements, designDocumentCatalog: _catalog, ...options } = parameters;
  if (tool !== undefined && (typeof tool !== "string" || tool === "layer-studio" || tool === "canvas-mask-edit" || tool === "midjourney-blend"
    || !getToolDefinition(tool)?.operations.some(operation => ["image_generation", "inpaint", "upscale", "batch_image", "seamless_stitch"].includes(operation)))) {
    throw new Error("豆包生图仅支持普通图片生成与无蒙版编辑");
  }
  if (count !== undefined && count !== 1) throw new Error("每个豆包生图任务只能生成 1 张图片");
  if (inputArchive && typeof inputArchive === "object" && !Array.isArray(inputArchive)) {
    const archive = inputArchive as Record<string, unknown>;
    if (archive.maskReferenceIndex !== undefined || archive.markupReferenceIndex !== undefined) throw new Error("豆包生图不支持独立蒙版或标注层");
  }
  if (options.layer_decomposition !== undefined || options.layer_decomposition_options !== undefined) throw new Error("图层拆分请使用独立图层工作区");
  if (typeof options.resolution === "string") options.resolution = options.resolution.toUpperCase();
  if (typeof options.size === "string" && /^(1|1\.5|2)k$/i.test(options.size)) options.size = options.size.toUpperCase();
  // The ordinary UI stores ratio + resolution separately. Upstream uses a tier
  // as size for adaptive framing, and accepts resolution only beside a ratio.
  if ((options.size === undefined || options.size === "auto") && options.resolution !== undefined) {
    options.size = options.resolution;
    delete options.resolution;
  }
  return validateLayerStudioOptions(options, prompt, sourceCount);
}
