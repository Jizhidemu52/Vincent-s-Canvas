import type { LayerStudioBoundingBox, LayerStudioBox, LayerStudioItem, LayerStudioOcr, LayerStudioResultDocument } from "../../shared/layer-studio";
import { layerStudioTaskOptions } from "../../shared/layer-studio-options";
import type { ApiMartImageInput, ApiMartImageRequest } from "./apimart-image";
import { isPublicHttpUrl } from "./apimart-upload";

export type Seedream55Manifest = {
  version: 1;
  mode: "generate" | "decompose";
  items: Array<{ url: string; expiresAt?: number; public: LayerStudioItem }>;
};

export class Seedream55OutputLimitExceeded extends Error {}
/** The upstream receipt is durable before this guard. Never download or bill
 * outputs beyond the exact original request, including on manual recovery. */
export function assertSeedream55ManifestLimit(manifest: Seedream55Manifest, parameters: Record<string, unknown>) {
  const layers = parameters.layer_decomposition === true;
  const controls = parameters.layer_decomposition_options as { max_images?: number } | undefined;
  const maximum = layers ? controls?.max_images ?? 30 : 1;
  if (manifest.mode !== (layers ? "decompose" : "generate") || !Number.isInteger(maximum) || maximum < (layers ? 2 : 1) || maximum > (layers ? 100 : 1) || manifest.items.length > maximum) {
    throw new Seedream55OutputLimitExceeded(`上游结果数量 ${manifest.items.length} 与原任务上限 ${maximum} 不符；已保留原回执并暂停保存，请联系管理员核查，不会重新生成`);
  }
}

export function buildSeedream55Request(input: ApiMartImageInput, encode = true): ApiMartImageRequest {
  if (input.maskImage || input.maskDataUrl || input.markupImage) throw new Error("图层工具不接收独立蒙版或标注层");
  const sources = input.sourceImages ?? input.sourceDataUrls ?? [];
  const options = layerStudioTaskOptions(input.parameters, input.prompt, sources.length);
  const payload: Record<string, unknown> = { model: "seedream-5-5", ...options, n: 1 };
  if (input.prompt.trim()) payload.prompt = input.prompt;
  if (options.layer_decomposition) {
    payload.size = options.size ?? options.resolution ?? "auto";
    delete payload.resolution;
  }
  if (sources.length) payload.image_urls = sources.map(source => {
    if (typeof source === "string") {
      if (!isPublicHttpUrl(source)) throw new Error("图层工具参考图必须来自已授权原件");
      return source;
    }
    if (!SEEDREAM55_MIMES.has(source.mimeType) || !source.bytes.length || source.bytes.length > 30 * 1024 * 1024) throw new Error("参考图片类型无效或超过 30 MiB");
    return encode ? `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}` : "validated-owned-image";
  });
  return { path: "/images/generations", payload, pollIntervalMs: 3_000, timeoutMs: 15 * 60_000 };
}

export const SEEDREAM55_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"]);
export function seedream55PollInterval(started: string | Date | null | undefined, now = Date.now()) {
  const elapsed = started ? now - new Date(started).getTime() : 0;
  return elapsed < 30_000 ? 3_000 : elapsed < 120_000 ? 5_000 : 10_000;
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max: number) { return typeof value === "string" ? value.slice(0, max) : undefined; }
function box(value: unknown, normalized = false): LayerStudioBox | undefined {
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > (normalized ? 1000 : 1_000_000))) return;
  return value[2] > value[0] && value[3] > value[1] ? value as LayerStudioBox : undefined;
}
function boundingBox(value: unknown): LayerStudioBoundingBox | undefined {
  const raw = object(value), absolute = box(raw.absolute), normalized = box(raw.normalized, true);
  return absolute || normalized ? { ...(absolute ? { absolute } : {}), ...(normalized ? { normalized } : {}) } : undefined;
}
function ocr(value: unknown): LayerStudioOcr | undefined {
  const raw = object(value);
  if (!Object.keys(raw).length) return;
  const result: LayerStudioOcr = {};
  if (typeof raw.text === "string") result.text = raw.text.slice(0, 20_000);
  if (Array.isArray(raw.lines)) result.lines = raw.lines.slice(0, 200).map(value => {
    const line = object(value), bounds = boundingBox(line.bounding_box);
    return { ...(bounds ? { boundingBox: bounds } : {}), ...(Array.isArray(line.runs) ? { runs: line.runs.slice(0, 100).map(value => {
      const run = object(value), source = object(run.style), style: NonNullable<NonNullable<NonNullable<LayerStudioOcr["lines"]>[number]["runs"]>[number]["style"]> = {};
      if (typeof source.similar_font_family === "string") style.similarFontFamily = source.similar_font_family.slice(0, 200);
      if (typeof source.foreground_color === "string" && /^#[\da-f]{6}$/i.test(source.foreground_color)) style.foregroundColor = source.foreground_color;
      for (const key of ["bold", "italic", "underline", "strikethrough", "shadow", "translucent"] as const) if (typeof source[key] === "boolean") style[key] = source[key];
      return { ...(typeof run.text === "string" ? { text: run.text.slice(0, 2000) } : {}), ...(Object.keys(style).length ? { style } : {}) };
    }) } : {}) };
  });
  return result;
}

/** Never filter or deduplicate URLs before pairing a group's optional metadata. */
export function parseSeedream55Manifest(payload: unknown, decompose: boolean): Seedream55Manifest {
  const groups = object(object(object(payload).data).result).images;
  if (!Array.isArray(groups) || !groups.length || groups.length > 100) throw new Error("图层任务结果清单无效");
  const result: Seedream55Manifest = { version: 1, mode: decompose ? "decompose" : "generate", items: [] };
  groups.forEach((value, groupIndex) => {
    const group = object(value), urls = group.url;
    if (!Array.isArray(urls) || !urls.length) throw new Error("图层任务结果地址清单无效");
    const parallel = (key: string, index: number) => Array.isArray(group[key]) && group[key].length === urls.length ? group[key][index] : undefined;
    urls.forEach((url, urlIndex) => {
      if (typeof url !== "string" || url.length > 16_384 || !isPublicHttpUrl(url) || result.items.length >= 100) throw new Error("图层任务结果地址或数量无效");
      const layer = object(parallel("layers", urlIndex));
      const size = /^(\d+)x(\d+)$/.exec(String(layer.size ?? parallel("sizes", urlIndex) ?? ""));
      const width = Number(size?.[1]), height = Number(size?.[2]);
      const background = layer.background ?? parallel("backgrounds", urlIndex);
      const format = layer.output_format ?? parallel("output_formats", urlIndex);
      const bounds = boundingBox(layer.bounding_box), recognition = ocr(layer.text_recognition);
      const item: LayerStudioItem = {
        index: result.items.length, groupIndex, urlIndex, state: "pending", role: decompose ? urlIndex === 0 ? "base" : "layer" : "image",
        ...(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : {}),
        ...(format === "png" || format === "jpeg" ? { mimeType: `image/${format}` } : {}),
        ...(background === "opaque" || background === "transparent" ? { background } : {}),
        ...(typeof layer.name === "string" ? { name: text(layer.name, 500) } : {}),
        ...(typeof layer.description === "string" ? { description: text(layer.description, 2000) } : {}),
        ...(Number.isSafeInteger(layer.z_index) ? { zIndex: layer.z_index as number } : {}),
        ...(bounds ? { boundingBox: bounds } : {}), ...(recognition ? { textRecognition: recognition } : {}),
      };
      result.items.push({ url, ...(Number.isSafeInteger(group.expires_at) ? { expiresAt: group.expires_at as number } : {}), public: item });
    });
  });
  if (!decompose && result.items.length !== 1) throw new Error("单次图片生成应返回一张图片");
  if (JSON.stringify(result).length > 2_000_000) throw new Error("图层结果元数据过大，暂停保存以便核查原任务");
  return result;
}

export function seedream55PublicDocument(taskId: string, manifest: Seedream55Manifest): LayerStudioResultDocument {
  return { version: 1, taskId, mode: manifest.mode, status: "persisting", expectedOutputCount: manifest.items.length, items: manifest.items.map(item => ({ ...item.public })) };
}
