export type OpenAiImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type OpenAiImageParameters = {
  size?: string;
  quality?: OpenAiImageQuality;
  background?: "auto" | "opaque" | "transparent";
  output_format?: "png" | "jpeg" | "webp";
  output_compression?: number;
};

export function isGptImage25(modelId?: string) {
  return modelId === "gpt-image-2.5-flare" || modelId === "gpt-image-2.5-sunburst";
}

export function hasFlexibleImageSize(modelId?: string) {
  return modelId === "gpt-image-2" || isGptImage25(modelId);
}

/** OpenToken's documented GPT Image 2 / 2.5 constraints, shared by both endpoints. */
export function normalizeOpenTokenImageSize(value?: string, modelId = "gpt-image-2") {
  const raw = String(value || "auto").trim().toLowerCase();
  const aliases: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "4:3": "1536x1024", "3:2": "1536x1024", landscape: "1536x1024", "9:16": "1024x1536", "3:4": "1024x1536", "2:3": "1024x1536", portrait: "1024x1536" };
  if (hasFlexibleImageSize(modelId)) Object.assign(aliases, { "16:9": "1536x864", "9:16": "864x1536", "4:3": "1536x1152", "3:4": "1152x1536" });
  const size = aliases[raw] || raw;
  if (["auto", "1024x1024", "1536x1024", "1024x1536"].includes(size)) return size;
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (hasFlexibleImageSize(modelId) && match && width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840
    && Math.max(width, height) / Math.min(width, height) <= 3 && width * height >= 655_360 && width * height <= 8_294_400) return size;
  throw new Error("图片尺寸无效：宽高须为 16 的倍数，单边不超过 3840，比例不超过 3:1，总像素为 655360–8294400；此模型还须支持自定义尺寸");
}

/** The OpenAI-compatible adapter supports quality, not APIMart resolution. */
export function openAiImageParameters(parameters: Record<string, unknown>, modelId = "gpt-image-2"): OpenAiImageParameters {
  // The configured non-preview Gemini alias has no documented Images API settings.
  if (modelId === "gemini-3.1-flash-image") return {};
  const value = String(parameters.quality || "").trim().toLowerCase();
  const qualities = ["auto", "low", "medium", "high", ...(isGptImage25(modelId) ? ["xhigh", "max"] : [])];
  if (value && !qualities.includes(value)) throw new Error("当前模型不支持所选画质");
  const quality = value || (parameters.resolution === "4k" ? "high" : parameters.resolution === "2k" ? "medium" : "auto");
  const result: OpenAiImageParameters = { size: normalizeOpenTokenImageSize(String(parameters.size || "auto"), modelId), quality: quality as OpenAiImageQuality };
  if (parameters.background !== undefined && parameters.background !== "") {
    if (!["auto", "opaque", "transparent"].includes(String(parameters.background))) throw new Error("图片背景参数无效");
    result.background = parameters.background as OpenAiImageParameters["background"];
  }
  if (parameters.output_format !== undefined && parameters.output_format !== "") {
    if (!["png", "jpeg", "webp"].includes(String(parameters.output_format))) throw new Error("图片输出格式无效");
    result.output_format = parameters.output_format as OpenAiImageParameters["output_format"];
  }
  if (result.background === "transparent") {
    if (result.output_format === "jpeg") throw new Error("透明背景只能使用 PNG 或 WebP 输出格式");
    result.output_format ||= "png";
  }
  if (parameters.output_compression !== undefined && parameters.output_compression !== "") {
    const compression = Number(parameters.output_compression);
    if (typeof parameters.output_compression === "boolean" || parameters.output_compression === null || !Number.isInteger(compression) || compression < 0 || compression > 100) throw new Error("图片压缩值须为 0–100 的整数");
    if (result.output_format !== "jpeg" && result.output_format !== "webp") throw new Error("图片压缩参数仅适用于 JPEG 或 WebP 输出");
    result.output_compression = compression;
  }
  return result;
}
