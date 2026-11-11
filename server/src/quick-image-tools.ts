import { isQuickImageAction, matchesQuickImageTaskTarget, type QuickImageAction } from "../../shared/quick-image-tools";
import { ToolConfigurationError } from "./tool-configuration";
import { apiMartImageModel } from "./apimart-image";

export const QUICK_IMAGE_RECIPE_VERSION = 1;
export function quickImageRecipeVersion(action: QuickImageAction) { return action === "remove-background" ? 2 : QUICK_IMAGE_RECIPE_VERSION; }
const DIRECT_CUTOUT_OUTPUT = "Return the finished full-color subject image with the background removed and real transparency in a PNG alpha channel. Do not return a mask, grayscale selection map, solid background or checkerboard. This image is the final result; no mask will be applied to the original.";
export const quickImageDefaultParameters: Record<QuickImageAction, Readonly<Record<string, unknown>>> = {
  "remove-background": {},
  "hd-upscale": { size: "auto", resolution: "4k" },
  "item-extract": { size: "auto", resolution: "2k", quality: "medium", background: "opaque", output_format: "png" },
};
export const quickImageDefaultPrompts: Record<QuickImageAction, string> = {
  "remove-background": [
    "Remove the background from the supplied image and return the complete main foreground subject, whether it is a person, animal, product, matching pair or coordinated set, with all its attached parts.",
    "Preserve the subject's colors, proportions, placement, material, text and visible details. Keep fine hair, fibers, straps, handles, lace and genuine holes; do not add or redesign details.",
    "Output a full-color PNG with a transparent background, not a black-and-white mask or a simulated checkerboard.",
  ].join("\n"),
  "hd-upscale": [
    "Faithfully upscale and restore the supplied image at the configured output resolution. This is restoration of the same image, not a new design.",
    "Preserve the full original frame and aspect ratio, composition, viewpoint, subject identity, shape, proportions, pose, placement, colors, lighting and background.",
    "Keep all text, logos, symbols, repeated motifs and pattern counts exactly as in the reference. Do not translate, replace, add, remove or reinterpret them.",
    "Recover natural edge clarity and existing fine texture with restrained denoising and deblurring. Do not invent texture, change material, smooth away craft detail, oversharpen or add halos.",
    "No crop, expansion, redesign, extra objects, watermark or captions. Return one restored image only.",
  ].join("\n"),
  "item-extract": [
    "Extract the complete main physical product shown in the supplied photograph into one clean, high-definition e-commerce product photograph on a pure white (#FFFFFF) background. This is a faithful product extraction and flat-lay presentation, not print artwork extraction, a technical drawing or a new design.",
    "Select the most visually prominent main product. If the main subject is an evident matching pair or coordinated set, keep all visible matching pieces and their original count together. Exclude unrelated products; do not merge different products, duplicate pieces or invent a missing mate.",
    "Remove the person, hands, body parts, mannequin, hanger, display supports, packaging unrelated to the product, surrounding objects and original scene. Do not leave skin, human-shaped bulges, supports or background fragments inside or around the product.",
    "Present clothing and flexible accessories naturally laid flat, front-facing to the camera, with the product fully visible and centered with a modest white margin. For rigid or inherently three-dimensional products, use the closest evidence-supported front/flat presentation while retaining their real volume; do not crush, unfold, split or turn them into a pattern piece. Do not reveal an unseen back or interior by rotating the product.",
    "Preserve the product identity and every visible design feature: silhouette, construction, proportions, cut, component relationships, colors, material boundaries, knit/weave/grain, texture, stitching, trims, fasteners, straps and decorations. Keep the exact count, shape, relative scale and placement of visible buttons, buckles, holes, prints, embroidery, repeated motifs, text and logos. Do not translate, rewrite, mirror, add, remove or redesign them.",
    "Only correct perspective and wearing-induced folds as needed for a plausible flat presentation without changing the cut or dimensions. Retain natural material texture and true construction folds. Restore only small, locally occluded areas when continuation is strongly supported by adjacent visible evidence; never invent hidden construction, unseen back details, labels, print content or a substantially missing product. When evidence is insufficient, retain the uncertainty instead of presenting fabricated details as real.",
    "Keep delicate fibers, lace openings, translucent parts, white-on-white edges and reflective highlights intact. Use clean, natural edge clarity and realistic material detail without invented texture, excessive smoothing, halos or artificial sharpening. The background must be solid white, not transparent, gray, checkerboard, a studio room, a floor texture or a gradient. Avoid cast shadows outside the product; retain only shading needed to describe its material and volume.",
    "Return one finished full-color product image only at the configured output resolution. No crop through the product, collage, before/after comparison, dimension lines, annotations, captions, watermark, added brand marks or extra objects.",
  ].join("\n"),
};

export type QuickImageSnapshot = Readonly<{ action: QuickImageAction; modelConfigId: string; modelId: string; prompt: string;
  parameters: Readonly<Record<string, unknown>>; configurationVersion: number; adminTest?: boolean }>;
/** Symbols cannot be supplied through JSON, and survive server-side object spreads. */
export const QUICK_IMAGE_SNAPSHOT = Symbol("server quick image snapshot");
export type QuickImageInput = {
  operationType: string; toolKey?: string | null; modelConfigId?: string | null; prompt?: string;
  promptInput?: unknown; sourceUrls: string[]; parameters?: Record<string, unknown>;
  [QUICK_IMAGE_SNAPSHOT]?: QuickImageSnapshot;
};

/** Only adapters with native alpha-output controls receive these parameters. */
export function quickImageOutputParameters<T>(action: QuickImageAction, modelId: string, parameters: Readonly<Record<string, T>>): Record<string, T | string> {
  const kind = apiMartImageModel(modelId);
  return action === "remove-background" && (kind?.startsWith("gpt-image-2.5-") || kind?.startsWith("gpt-image-2.6-"))
    ? { ...parameters, background: "transparent", output_format: "png" } : { ...parameters };
}

/** Rebuild the complete recipe: no client prompt, model, size, mask or metadata can override it. */
export function prepareQuickImageTask<T extends QuickImageInput>(input: T, snapshot?: QuickImageSnapshot): T {
  const tool = input.toolKey ?? input.parameters?.tool;
  const requested = input.parameters?.quickImageAction;
  if (requested === undefined) {
    // This metadata is server-owned even on other boards.
    if (!input.parameters || !("quickImage" in input.parameters)) return input;
    const { quickImage: _untrusted, ...parameters } = input.parameters;
    return { ...input, parameters };
  }
  if (!isQuickImageAction(requested)) throw new ToolConfigurationError("QUICK_IMAGE_ACTION_INVALID", "一键图片操作无效");
  if (!matchesQuickImageTaskTarget(requested, tool, input.operationType)) throw new ToolConfigurationError("TOOL_OPERATION_MISMATCH", "一键图片操作与当前板块不匹配");
  if (input.sourceUrls.length !== 1 || !input.sourceUrls[0]?.trim()) throw new ToolConfigurationError("QUICK_IMAGE_SOURCE_REQUIRED", "请上传或选择一张需要处理的图片");
  const action = requested;
  if (snapshot && snapshot.action !== action) throw new ToolConfigurationError("QUICK_IMAGE_ACTION_INVALID", "一键图片配置与操作不匹配");
  const prompt = snapshot?.prompt ?? quickImageDefaultPrompts[action];
  return {
    ...input, toolKey: tool, modelConfigId: snapshot?.modelConfigId, promptInput: undefined,
    prompt: action === "remove-background" ? `${prompt}\n\n${DIRECT_CUTOUT_OUTPUT}` : prompt,
    ...(snapshot ? { [QUICK_IMAGE_SNAPSHOT]: snapshot } : {}),
    parameters: { ...quickImageOutputParameters(action, snapshot?.modelId ?? "", snapshot?.parameters ?? quickImageDefaultParameters[action]), tool, n: 1, count: 1, quickImageAction: action,
      quickImage: { action, recipeVersion: quickImageRecipeVersion(action), ...(snapshot ? { configurationVersion: snapshot.configurationVersion, ...(snapshot.adminTest ? { adminTest: true } : {}) } : {}) } },
  };
}

export function quickImageResultAction(parameters: Record<string, unknown>) {
  const action = parameters.quickImageAction;
  const recipe = parameters.quickImage;
  if (!isQuickImageAction(action) || !recipe || typeof recipe !== "object" || Array.isArray(recipe)) return undefined;
  const value = recipe as Record<string, unknown>;
  // Recognize retired tasks so they fail safely instead of exposing an old mask as a finished image.
  return value.action === action && (value.recipeVersion === QUICK_IMAGE_RECIPE_VERSION || value.recipeVersion === quickImageRecipeVersion(action)) ? action : undefined;
}
