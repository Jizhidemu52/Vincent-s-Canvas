import { z } from "zod";

export const LAYER_STUDIO_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "2:1", "1:2"] as const;
export const LAYER_STUDIO_TIERS = ["1K", "1.5K", "2K"] as const;
export const LAYER_STUDIO_MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
export const LAYER_STUDIO_MAX_REFERENCE_PIXELS = 36_000_000;
export const layerStudioOptionsSchema = z.object({
  n: z.literal(1).optional(),
  size: z.string().max(40).optional(),
  resolution: z.enum(["1K", "1.5K", "2K", "auto"]).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  output_format: z.enum(["png", "jpeg"]).optional(),
  watermark: z.boolean().optional(),
  nsfw_check: z.boolean().optional(),
  optimize_prompt_options: z.object({ mode: z.literal("standard") }).strict().optional(),
  layer_decomposition: z.boolean().optional(),
  layer_decomposition_options: z.object({
    max_images: z.number().int().min(2).max(100).optional(),
    text_recognition: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type LayerStudioOptions = z.infer<typeof layerStudioOptionsSchema>;

/** Same strict, provider-neutral validator in UI, admission and adapter. */
export function validateLayerStudioOptions(parameters: unknown, prompt: string, sourceCount: number): LayerStudioOptions {
  const value = layerStudioOptionsSchema.parse(parameters);
  const layers = value.layer_decomposition === true;
  if (!Number.isInteger(sourceCount) || sourceCount < 0 || sourceCount > 10 || (layers && sourceCount !== 1)) throw new Error(layers ? "图层拆分必须恰好提供 1 张参考图" : "图片生成最多支持 10 张参考图");
  if (!layers && !prompt.trim()) throw new Error("图片生成必须填写提示词；仅拆层可省略");
  if (layers && value.background !== undefined) throw new Error("图层拆分不能传 background，包括 auto");
  if (!layers && value.layer_decomposition_options !== undefined) throw new Error("仅拆层模式可设置图层数量与 OCR");
  if (value.background === "transparent" && value.output_format === "jpeg") throw new Error("透明背景必须输出 PNG");
  const tiers = [...LAYER_STUDIO_TIERS, "auto"] as readonly string[];
  if (layers) {
    if (value.size !== undefined && !tiers.includes(value.size)) throw new Error("拆层尺寸仅支持 1K、1.5K、2K 或 auto");
  } else {
    if (value.resolution === "auto") throw new Error("生成 resolution 仅支持 1K、1.5K 或 2K");
    if (value.size !== undefined && !tiers.includes(value.size)) {
      const ratio = value.size.replace("x", ":");
      if (!(LAYER_STUDIO_RATIOS as readonly string[]).includes(ratio)) {
        const pixels = /^([1-9]\d*)x([1-9]\d*)$/.exec(value.size);
        const width = Number(pixels?.[1]); const height = Number(pixels?.[2]);
        if (!pixels || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height < 921_600 || width * height > 4_624_220 || width / height < 1 / 16 || width / height > 16) throw new Error("精确尺寸需 921600–4624220 总像素，宽高比 1/16–16");
        if (value.resolution !== undefined) throw new Error("精确像素尺寸不能同时传 resolution");
      }
    }
    if (value.resolution !== undefined && (value.size === undefined || tiers.includes(value.size))) throw new Error("生成 resolution 需与宽高比 size 配合");
  }
  return value;
}

/** Internal task bookkeeping is never forwarded to the provider. */
export function layerStudioTaskOptions(parameters: Record<string, unknown>, prompt: string, sourceCount: number) {
  const { tool, count, ...options } = parameters;
  if (tool !== undefined && tool !== "layer-studio") throw new Error("图层工具标识不匹配");
  if (count !== undefined && count !== 1) throw new Error("每个图层任务只能提交一次生成");
  return validateLayerStudioOptions(options, prompt, sourceCount);
}
