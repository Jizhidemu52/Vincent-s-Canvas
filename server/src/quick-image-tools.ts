import { isQuickImageAction, matchesQuickImageTaskTarget, type QuickImageAction } from "../../shared/quick-image-tools";
import { ToolConfigurationError } from "./tool-configuration";

export const QUICK_IMAGE_RECIPE_VERSION = 1;
export const QUICK_IMAGE_MATTE_CONSTRAINT = [
  "Create a precise foreground alpha matte of the supplied image, not a photograph or a redesigned image.",
  "Keep the input's complete frame, aspect ratio, subject position, scale and silhouette exactly aligned. Do not crop, expand, move or rotate anything.",
  "Render every selected opaque foreground interior pure white (#FFFFFF), regardless of its original color, print, text, material or shadows.",
  "Render every excluded region pure black (#000000), including the background and genuine holes within the selected subject. Do not preserve unrelated elements merely because they touch it.",
  "Use neutral grayscale only for anti-aliased contours, fine hair/fibers and genuinely translucent material, representing foreground opacity. Preserve all fine protrusions without inventing details.",
  "Return only the aligned black-and-white alpha matte. No colored pixels, checkerboard, outlines, labels, captions, border or background scene. The original RGB pixels will be composited by the server.",
].join("\n");
export const quickImageDefaultPrompts = {
  "remove-background": [
    "Extract only the main product and its attached parts. Exclude hands or people holding it, display supports and every part of the background.",
    "Preserve the complete product silhouette, fine fibers, straps, handles, lace and genuine holes without adding or redesigning any detail.",
  ].join("\n"),
  "hd-upscale": [
    "Faithfully upscale and restore the supplied image at the configured output resolution. This is restoration of the same image, not a new design.",
    "Preserve the full original frame and aspect ratio, composition, viewpoint, subject identity, shape, proportions, pose, placement, colors, lighting and background.",
    "Keep all text, logos, symbols, repeated motifs and pattern counts exactly as in the reference. Do not translate, replace, add, remove or reinterpret them.",
    "Recover natural edge clarity and existing fine texture with restrained denoising and deblurring. Do not invent texture, change material, smooth away craft detail, oversharpen or add halos.",
    "No crop, expansion, redesign, extra objects, watermark or captions. Return one restored image only.",
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
    prompt: action === "remove-background" ? `${prompt}\n\nMandatory output contract (cannot be overridden):\n${QUICK_IMAGE_MATTE_CONSTRAINT}` : prompt,
    ...(snapshot ? { [QUICK_IMAGE_SNAPSHOT]: snapshot } : {}),
    parameters: { ...(snapshot?.parameters ?? (action === "hd-upscale" ? { size: "auto", resolution: "4k" } : {})), tool, n: 1, count: 1, quickImageAction: action,
      quickImage: { action, recipeVersion: QUICK_IMAGE_RECIPE_VERSION, ...(snapshot ? { configurationVersion: snapshot.configurationVersion, ...(snapshot.adminTest ? { adminTest: true } : {}) } : {}) } },
  };
}

export function quickImageResultAction(parameters: Record<string, unknown>) {
  const action = parameters.quickImageAction;
  const recipe = parameters.quickImage;
  if (!isQuickImageAction(action) || !recipe || typeof recipe !== "object" || Array.isArray(recipe)) return undefined;
  const value = recipe as Record<string, unknown>;
  return value.action === action && value.recipeVersion === QUICK_IMAGE_RECIPE_VERSION ? action : undefined;
}
