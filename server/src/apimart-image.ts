import { fetchProviderSubmission } from "./provider-submission-transport";
import { queryProviderTaskStatus } from "./provider-status-query";
import { isDefinitiveSubmissionRejection } from "./provider-submission-policy";
import { apiMartPollIntervalMs } from "./apimart-poll-interval";
import { isPublicHttpUrl, uploadApiMartImage, validateApiMartGenerationImage } from "./apimart-upload";

type MarkImageModel = "gpt-image-2.5-flare" | "gpt-image-2.5-sunburst" | "gemini-nano-banana-2.1";
type GrokImageModel = "grok-imagine-image-2.0";
export type ApiMartImageModel = "gpt-image-2" | "gemini-3.1-flash-image-preview" | "midjourney" | "midjourney-blend" | MarkImageModel | GrokImageModel;
export type ApiMartImageBytes = { bytes: Uint8Array; mimeType: string; filename?: string };
type ImageReference = string | ApiMartImageBytes;

export type ApiMartImageInput = {
  modelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  sourceDataUrls?: string[];
  /** Owned source bytes stay binary until an upload or inline-JSON boundary. */
  sourceImages?: ImageReference[];
  /** Already-authorized PNG mask; the caller verifies alpha and source dimensions. */
  maskDataUrl?: string;
  maskImage?: ApiMartImageBytes;
};

export type ApiMartImageRequest = {
  path: string;
  payload: Record<string, unknown>;
  pollIntervalMs: number;
  timeoutMs: number;
};

const GEMINI_MODELS = new Set([
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-image-preview-official",
  "nano-banana-2-ext",
  "nano-banana-2",
]);

const GPT_MODELS = new Set(["gpt-image-2", "gpt-image-2-ext", "vcen-gpt2"]);
const MARK_IMAGE_MODELS = new Set<string>(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gemini-nano-banana-2.1"]);

const IMAGE_STATUSES = new Set(["pending", "submitted", "processing", "queued", "running"]);
const IMAGE_FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled"]);
// Verified against the provider's live request tables; see docs/manual/image-model-parameters.md.
const GPT_RATIOS = new Set(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"]);
const GEMINI_RATIOS = new Set(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "1:4", "4:1", "1:8", "8:1"]);
const GROK_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "auto"];
const GROK_RESPONSE_VERSION = "2026-07-27";

export function apiMartImageModel(modelId: string): ApiMartImageModel | null {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "grok-imagine-image-2.0") return normalized;
  if (MARK_IMAGE_MODELS.has(normalized)) return normalized as MarkImageModel;
  if (GPT_MODELS.has(normalized)) return "gpt-image-2";
  if (GEMINI_MODELS.has(normalized)) return "gemini-3.1-flash-image-preview";
  if (normalized === "midjourney-blend") return "midjourney-blend";
  if (normalized === "midjourney" || normalized === "midjourney-v7") return "midjourney";
  return null;
}

export function buildApiMartImageRequest(input: ApiMartImageInput): ApiMartImageRequest {
  return buildImageRequest(input, true);
}

function buildImageRequest(input: ApiMartImageInput, encodeReferences: boolean): ApiMartImageRequest {
  const kind = apiMartImageModel(input.modelId);
  if (!kind) throw new Error(`不支持的 APIMart 图片模型：${input.modelId}`);
  if (isMarkImageModel(kind)) return buildMarkImageRequest(input, kind, false, encodeReferences);
  if (kind === "grok-imagine-image-2.0") return buildGrokImageRequest(input);

  const references = imageReferences(input);
  if (kind === "midjourney-blend") {
    if (references.length < 2 || references.length > 4)
      throw new Error("Midjourney Blend requires 2 to 4 reference images");
    if (input.maskDataUrl !== undefined || input.maskImage !== undefined) throw new Error("Midjourney Blend 不支持独立蒙版");
    if (input.parameters.n !== undefined && input.parameters.n !== 1) throw new Error("每个 Midjourney Blend 任务只能提交一次融合");
    for (const reference of references) {
      if (typeof reference !== "string" || reference.startsWith("data:")) {
        if (decodeGenerationReference(reference).bytes.byteLength > 12 * 1024 * 1024) throw new Error("Midjourney Blend 单张参考图不能超过 12 MiB");
      } else if (!isPublicHttpUrl(reference)) throw new Error("Blend 参考图必须为公开 HTTP(S) URL；本地图片请先上传");
    }
    const options = apiMartImageOptions(input.parameters, kind);
    const size = input.parameters.size;
    if (size !== undefined) {
      if (typeof size !== "string" || !/^[1-9]\d*:[1-9]\d*$/.test(size)) throw new Error("Midjourney Blend size 必须为正整数宽高比，例如 16:9");
      delete options.dimensions;
    } else options.dimensions ??= "SQUARE";
    return {
      path: "/midjourney/generations/blend",
      payload: {
        image_urls: referencePayload(references, encodeReferences),
        ...(size !== undefined ? { size } : {}),
        speed: enumParameter(input.parameters.speed !== undefined ? input.parameters.speed : input.parameters.midjourneySpeed, ["relax", "fast", "turbo"], "speed", "relax"),
        ...options,
      },
      pollIntervalMs: 2_000,
      timeoutMs: 15 * 60_000,
    };
  }
  validateInlineReferences(references, kind);
  if (kind === "midjourney") {
    assertSingleMidjourneyGeneration(input.prompt, input.parameters);
    return {
      path: "/midjourney/generations",
      payload: {
        prompt: input.prompt,
        size: normalizeAspect(input.parameters.size, kind),
        ...(input.parameters.midjourneyVersion ? { version: String(input.parameters.midjourneyVersion) } : {}),
        ...(references.length ? { image_urls: referencePayload(references, encodeReferences) } : {}),
        speed: normalizeMidjourneySpeed(input.parameters.midjourneySpeed),
        ...apiMartImageOptions(input.parameters, kind),
      },
      pollIntervalMs: 2_000,
      timeoutMs: 15 * 60_000,
    };
  }

  const maximumReferences = kind === "gpt-image-2" ? 15 : 14;
  if (references.length > maximumReferences) {
    throw new Error(`${kind === "gpt-image-2" ? "GPT-Image-2" : "Gemini 3.1 Flash"} 最多支持 ${maximumReferences} 张参考图`);
  }

  const payload: Record<string, unknown> = {
    model: normalizeModelId(kind, input.modelId),
    prompt: input.prompt,
    n: 1, // UI batch counts are split into independent tasks before reaching the adapter.
    size: normalizeAspect(input.parameters.size, kind),
    resolution: kind === "gpt-image-2" ? normalizeGptResolution(input.parameters.resolution) : normalizeGeminiResolution(input.parameters.resolution),
    ...apiMartImageOptions(input.parameters, kind),
  };
  if (references.length) payload.image_urls = referencePayload(references, encodeReferences);
  if (kind === "gemini-3.1-flash-image-preview") {
    if (String(payload.model).endsWith("-official")) delete payload.official_fallback;
    if (input.parameters.officialFallback === true && !String(payload.model).endsWith("-official")) payload.official_fallback = true;
    if (input.parameters.googleSearch === true) payload.google_search = true;
    if (input.parameters.googleImageSearch === true) {
      payload.google_search = true;
      payload.google_image_search = true;
    }
  }

  return { path: "/images/generations", payload, pollIntervalMs: 2_000, timeoutMs: 15 * 60_000 };
}

function isMarkImageModel(kind: ApiMartImageModel): kind is MarkImageModel {
  return MARK_IMAGE_MODELS.has(kind);
}

/** Official Grok 2.0 is distinct from the text-only Ext endpoint contract. */
function buildGrokImageRequest(input: ApiMartImageInput, allowInlineReferences = false, encodeReferences = true): ApiMartImageRequest {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 8000) throw new Error("Grok 2.0 图片描述不能为空，且不能超过 8000 个字符");
  const parameters = input.parameters;
  if (parameters.n !== undefined && parameters.n !== 1) throw new Error("画布已拆分批量任务，每个 Grok 图片任务的 n 必须为 1");
  if (input.maskDataUrl !== undefined || input.maskImage !== undefined) throw new Error("Grok 2.0 不支持独立蒙版参数");
  const references = imageReferences(input);
  if (references.length > 3) throw new Error("Grok 2.0 最多支持 3 张参考图");
  for (const reference of references) {
    if (allowInlineReferences && (typeof reference !== "string" || reference.startsWith("data:"))) {
      const source = decodeGenerationReference(reference);
      if (!["image/jpeg", "image/png", "image/webp"].includes(source.mimeType) || source.bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error("Grok 参考图仅支持不超过 10 MiB 的 JPEG、PNG 或 WebP");
      }
    } else if (typeof reference !== "string" || !isPublicHttpUrl(reference)) throw new Error("Grok 参考图必须为公开 HTTP(S) URL；本地图片请先上传");
  }
  const payload: Record<string, unknown> = {
    model: "grok-imagine-image-2.0", prompt, n: 1,
    aspect_ratio: enumParameter(parameters.aspect_ratio !== undefined ? parameters.aspect_ratio : parameters.size, GROK_RATIOS, "aspect_ratio", "auto"),
    resolution: enumParameter(parameters.resolution, ["1k", "2k"], "resolution", "1k"),
  };
  // Quality is text-to-image only. A previous UI value must never leak into an edit request.
  if (references.length) payload.image_urls = referencePayload(references, encodeReferences);
  else payload.quality = enumParameter(parameters.quality, ["low", "medium"], "quality", "medium");
  if (parameters.nsfw_check !== undefined) {
    if (typeof parameters.nsfw_check !== "boolean") throw new Error("nsfw_check 必须为布尔值");
    payload.nsfw_check = parameters.nsfw_check;
  }
  return { path: "/images/generations", payload, pollIntervalMs: 2_000, timeoutMs: 15 * 60_000 };
}

/** These exact models have a different contract from the legacy GPT2/Nano2 aliases. */
function buildMarkImageRequest(input: ApiMartImageInput, model: MarkImageModel, allowInlineGptReferences = false, encodeReferences = true): ApiMartImageRequest {
  if (!input.prompt.trim()) throw new Error("请填写图像生成或编辑描述");
  const gpt = model !== "gemini-nano-banana-2.1";
  const parameters = input.parameters;
  // Business metadata (count, tool, inputArchive, operationType, etc.) is not forwarded.
  const unsupported = ["official_fallback", "officialFallback", "nsfw_check", "google_search", "googleSearch", "google_image_search", "googleImageSearch", "midjourneySpeed", "midjourneyQuality", "mask_url", "maskUrl", "maskDataUrl"];
  if (!gpt) unsupported.push("quality", "background", "output_format", "output_compression", "moderation");
  for (const key of unsupported) if (parameters[key] !== undefined) throw new Error(`${model} 不支持参数 ${key}`);
  if (parameters.n !== undefined && parameters.n !== 1) throw new Error("画布已拆分批量任务，每个 APIMart 图片任务的 n 必须为 1");

  const references = imageReferences(input);
  if (gpt && references.length > 16) throw new Error("GPT-Image-2.5 最多支持 16 张参考图");
  for (const reference of references) {
    if ((typeof reference !== "string" || reference.startsWith("data:")) && (!gpt || allowInlineGptReferences)) decodeGenerationReference(reference);
    else if (typeof reference !== "string" || !isPublicHttpUrl(reference)) throw new Error("参考图必须为公开 HTTP(S) URL；本地图片请先上传");
  }

  const payload: Record<string, unknown> = {
    model, prompt: input.prompt, n: 1,
    resolution: normalizeMarkResolution(parameters.resolution, gpt),
  };
  if (parameters.size !== undefined) payload.size = normalizeMarkSize(parameters.size, gpt);
  if (references.length) payload.image_urls = referencePayload(references, encodeReferences);
  if (gpt) {
    payload.quality = enumParameter(parameters.quality, ["auto", "low", "medium", "high", "xhigh", "max"], "quality", "auto");
    for (const [key, allowed] of Object.entries({ output_format: ["png", "jpeg", "webp"], background: ["auto", "opaque", "transparent"], moderation: ["auto", "low"] })) {
      if (parameters[key] !== undefined) payload[key] = enumParameter(parameters[key], allowed, key);
    }
    const format = payload.output_format || "png";
    if (payload.background === "transparent" && format === "jpeg") throw new Error("透明背景仅支持 PNG 或 WebP，不能使用 JPEG");
    if (parameters.output_compression !== undefined) {
      const compression = parameters.output_compression;
      if (typeof compression !== "number" || !Number.isInteger(compression) || compression < 0 || compression > 100) throw new Error("output_compression 必须为 0–100 的整数");
      if (format !== "jpeg" && format !== "webp") throw new Error("output_compression 仅支持 JPEG 或 WebP");
      payload.output_compression = compression;
    }
  }
  const maskInput = input.maskImage ?? input.maskDataUrl;
  if (maskInput !== undefined) {
    if (!gpt) throw new Error("Nano 2.1 不支持独立蒙版参数");
    if (!references.length) throw new Error("蒙版编辑必须提供第一张原图");
    const mask = decodeGenerationReference(maskInput);
    if (mask.mimeType !== "image/png" || mask.bytes.byteLength >= 4 * 1024 * 1024) throw new Error("蒙版必须为小于 4MB 的 PNG Data URL");
    payload.mask_url = typeof maskInput === 'string' ? maskInput : imageDataUrl(maskInput);
  }
  return { path: "/images/generations", payload, pollIntervalMs: gpt ? 2_000 : 3_000, timeoutMs: 15 * 60_000 };
}

function enumParameter(value: unknown, allowed: string[], name: string, fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${name} 必须为 ${allowed.join("/")}`);
  return value;
}

function normalizeMarkResolution(value: unknown, gpt: boolean) {
  const resolution = value === undefined ? "1k" : typeof value === "string" ? value.toLowerCase() : "";
  if (!["1k", "2k", "4k"].includes(resolution)) throw new Error("resolution 仅支持 1K/2K/4K，不能用画质档位或 0.5K");
  return gpt ? resolution : resolution.toUpperCase();
}

function normalizeMarkSize(value: unknown, gpt: boolean) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const size = gpt ? raw : raw.replace("x", ":");
  if ((gpt ? GPT_RATIOS : GEMINI_RATIOS).has(size)) return size;
  const pixels = gpt ? /^([1-9]\d*)x([1-9]\d*)$/.exec(size) : null;
  if (pixels) {
    const width = Number(pixels[1]), height = Number(pixels[2]);
    if (width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840
      && Math.max(width, height) / Math.min(width, height) <= 3 && width * height >= 655_360 && width * height <= 8_294_400) return size;
    throw new Error("GPT2.5 像素尺寸须为 16 的倍数，单边不超过 3840，比例不超过 3:1，总像素为 655360–8294400");
  }
  throw new Error(`${gpt ? "GPT2.5" : "Nano 2.1"} 不支持尺寸或比例 ${size}`);
}

function imageReferences(input: ApiMartImageInput): ImageReference[] { return input.sourceImages ?? input.sourceDataUrls ?? []; }

function imageDataUrl(source: ApiMartImageBytes) {
  return `data:${source.mimeType};base64,${Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength).toString('base64')}`;
}

function referencePayload(references: ImageReference[], encode: boolean) {
  // Upload-only request builders retain the original views until every upload
  // succeeds; stepApiMartImageTask replaces this field before serialization.
  return references.map(reference => typeof reference === 'string' || !encode ? reference : imageDataUrl(reference));
}

function decodeGenerationReference(value: ImageReference): ApiMartImageBytes {
  if (typeof value !== 'string') { validateApiMartGenerationImage(value); return value; }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) throw new Error("参考图必须为有效的 JPEG/PNG/WebP/GIF Base64 Data URL");
  const bytes = Buffer.from(match[2]!, "base64");
  const source = { bytes, mimeType: match[1]! };
  validateApiMartGenerationImage(source);
  return source;
}

function assertSingleMidjourneyGeneration(prompt: string, parameters: Record<string, unknown>) {
  const nativeRepeat = /--(?:repeat|r)(?=$|[\s=:\d])/i;
  if ((parameters.repeat !== undefined && parameters.repeat !== 1)
    || nativeRepeat.test(prompt)
    || (typeof parameters.extra === "string" && nativeRepeat.test(parameters.extra))) {
    throw new Error("单次仅允许生成 1 张；请移除 Midjourney repeat 参数及 --repeat/--r 重复生成命令");
  }
}

/** Documented optional fields only; reject malformed values before the paid submission. */
export function apiMartImageOptions(parameters: Record<string, unknown>, kind: Exclude<ApiMartImageModel, MarkImageModel | GrokImageModel>) {
  const options: Record<string, unknown> = {};
  const bool = (key: string) => {
    if (parameters[key] === undefined) return;
    if (typeof parameters[key] !== "boolean") throw new Error(`${key} 必须为布尔值`);
    options[key] = parameters[key];
  };
  bool("nsfw_check");
  if (kind === "gpt-image-2" || kind === "gemini-3.1-flash-image-preview") {
    bool("official_fallback");
    if (kind === "gemini-3.1-flash-image-preview") {
      bool("google_search"); bool("google_image_search");
      if (options.google_image_search) options.google_search = true;
    }
    return options;
  }
  if (parameters.metadata !== undefined) {
    if (!parameters.metadata || typeof parameters.metadata !== "object" || Array.isArray(parameters.metadata)) throw new Error("metadata 必须为对象");
    options.metadata = parameters.metadata;
  }
  if (kind === "midjourney-blend") {
    if (parameters.dimensions !== undefined) {
      if (!["SQUARE", "PORTRAIT", "LANDSCAPE"].includes(String(parameters.dimensions))) throw new Error("dimensions 必须为 SQUARE/PORTRAIT/LANDSCAPE");
      options.dimensions = parameters.dimensions;
    }
    return options;
  }
  assertSingleMidjourneyGeneration("", parameters);
  for (const key of ["tile", "niji", "raw", "draft", "hd"]) bool(key);
  for (const key of ["version", "style", "negative_prompt", "cref", "sref", "dref", "extra"]) {
    if (parameters[key] === undefined) continue;
    if (typeof parameters[key] !== "string" || !parameters[key].trim()) throw new Error(`${key} 必须为非空文本`);
    options[key] = parameters[key];
  }
  if (parameters.midjourneyQuality !== undefined) {
    if (!["0.25", "0.5", "1", "2"].includes(String(parameters.midjourneyQuality))) throw new Error("Midjourney quality 必须为 0.25/0.5/1/2");
    options.quality = String(parameters.midjourneyQuality);
  }
  const ranges: Record<string, [number, number, boolean]> = { seed: [0, 4294967295, true], stylize: [0, 1000, true], chaos: [0, 100, true], weird: [0, 3000, true], iw: [0, 3, false], cw: [0, 100, true], sw: [0, 1000, true], dw: [0, 100, false], stop: [10, 100, true] };
  for (const [key, [min, max, integer]] of Object.entries(ranges)) {
    const value = parameters[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${key} 必须为 ${min}–${max} 范围内的${integer ? "整数" : "数值"}`);
    options[key] = value;
  }
  return options;
}

/** Only an explicit provider terminal failure is safe to settle as a failed task. */
export class ApiMartImageProviderFailure extends Error {
  readonly code = "PROVIDER_TERMINAL_FAILURE";
}

export class ApiMartImageTaskPending extends Error {
  constructor(public readonly nextPollMs = 2_000) { super("图片仍在生成，等待下一次状态查询"); }
}

export type ApiMartImageTaskInput = ApiMartImageInput & {
  baseUrl: string;
  apiKey: string;
  /** Stable local task UUID; Grok requires it before a new paid submission. */
  submissionKey?: string;
  upstreamTaskId?: string | null;
  submissionStarted?: boolean;
  /** Persisted original submission time; never the current execution/resume time. */
  submissionStartedAt?: string | Date | null;
  beforeSubmit?: () => void | Promise<void>;
  onSubmitted?: (taskId: string) => void | Promise<void>;
};

type ImageRuntime = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
};

export type ApiMartImageTaskStep =
  | { status: "pending"; upstreamTaskId: string; nextPollMs: number }
  | { status: "completed"; upstreamTaskId: string; urls: string[] };

/** One paid submission OR one status query; durable workers schedule the next step. */
export async function stepApiMartImageTask(input: ApiMartImageTaskInput, runtime: ImageRuntime = {}): Promise<ApiMartImageTaskStep> {
  if (!input.apiKey.trim()) throw new Error("APIMart 服务端 API Key 未配置");
  const kind = apiMartImageModel(input.modelId);
  if (!kind) throw new Error(`不支持的 APIMart 图片模型：${input.modelId}`);
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const queryHeaders: Record<string, string> = { authorization: `Bearer ${input.apiKey}` };
  if (kind === "grok-imagine-image-2.0") {
    queryHeaders.accept = "application/json";
    queryHeaders["x-apimart-response-version"] = GROK_RESPONSE_VERSION;
  }
  const headers: Record<string, string> = { ...queryHeaders, "content-type": "application/json" };
  const poll = runtime.fetch || fetch;
  const wait = runtime.sleep || sleep;
  let taskId = input.upstreamTaskId?.trim();
  let pollIntervalMs = kind === "gemini-nano-banana-2.1" ? 3_000 : 2_000;
  if (!taskId) {
    if (input.submissionStarted) throw new Error("图片提交状态未知；为避免重复收费，不会自动重新提交，请核查上游任务");
    if (kind === "grok-imagine-image-2.0") {
      if (typeof input.submissionKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.submissionKey)) {
        throw new Error("Grok 2.0 必须使用已持久化的任务 UUID 作为 submissionKey");
      }
      headers["idempotency-key"] = input.submissionKey;
    }
    // Validate ALL parameters and local reference bytes before the first upload.
    const uploadsReferences = isMarkImageModel(kind) || kind === "midjourney-blend" || kind === "grok-imagine-image-2.0";
    const sources = imageReferences(input).map(reference => uploadsReferences && typeof reference === 'string' && reference.startsWith('data:') ? decodeGenerationReference(reference) : reference);
    const preparedInput = { ...input, sourceImages: sources };
    const request = isMarkImageModel(kind) ? buildMarkImageRequest(preparedInput, kind, true, false)
      : kind === "grok-imagine-image-2.0" ? buildGrokImageRequest(preparedInput, true, false) : buildImageRequest(preparedInput, !uploadsReferences);
    if (uploadsReferences && sources.length) {
      request.payload.image_urls = await uploadApiMartImageReferences(sources, baseUrl, input.apiKey, runtime);
    }
    pollIntervalMs = request.pollIntervalMs;
    // Persist the intent immediately before the paid POST. Never retry a POST here.
    await input.beforeSubmit?.();
    const submit = await (runtime.fetch || fetchProviderSubmission)(`${baseUrl}${request.path}`, {
      method: "POST", headers, body: JSON.stringify(request.payload), redirect: "error", signal: AbortSignal.timeout(180_000),
    });
    if (!submit.ok) {
      const message = `APIMart 图片任务提交失败：${submit.status} ${await providerMessage(submit, input.apiKey)}`;
      throw Object.assign(isDefinitiveSubmissionRejection(submit.status) ? new ApiMartImageProviderFailure(message) : new Error(message), { code: "PROVIDER_SUBMISSION_HTTP_ERROR", httpStatus: submit.status });
    }
    taskId = readTaskId(await submit.json());
    if (!taskId) throw Object.assign(new Error("APIMart 图片任务未返回 task_id；请核查上游状态，不会自动重新提交"), { code: "PROVIDER_TASK_ID_MISSING" });
    // A failed persistence callback must stop before GET; the caller retains the submission intent.
    await input.onSubmitted?.(taskId);
    return { status: "pending", upstreamTaskId: taskId, nextPollMs: pollIntervalMs };
  }

  const statusResponse = await queryProviderTaskStatus(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, queryHeaders, { fetch: poll, sleep: wait });
  if (!statusResponse.ok) throw Object.assign(new Error(`APIMart 图片任务状态查询失败：${statusResponse.status} ${await providerMessage(statusResponse, input.apiKey)}`), { code: "PROVIDER_POLL_HTTP_ERROR", httpStatus: statusResponse.status });
  const statusPayload = await statusResponse.json();
  const status = readStatus(statusPayload);
  if (IMAGE_FAILURE_STATUSES.has(status)) throw new ApiMartImageProviderFailure(redactProviderCredential(readFailureMessage(statusPayload), input.apiKey) || "APIMart 图片任务失败");
  if (status === "completed") {
    const outputs = readOutputUrls(statusPayload);
    if (!outputs.length) throw Object.assign(new Error("APIMart 图片任务完成但没有结果图片；可恢复查询原任务，不会重新生成"), { code: "PROVIDER_RESULT_MISSING" });
    if ((isMarkImageModel(kind) || kind === "midjourney-blend" || kind === "grok-imagine-image-2.0") && outputs.some(url => !isPublicHttpUrl(url))) throw Object.assign(new Error("APIMart 图片任务返回了无效结果地址；可恢复查询原任务，不会重新生成"), { code: "PROVIDER_RESULT_URL_INVALID" });
    return { status: "completed", upstreamTaskId: taskId, urls: outputs };
  }
  if (!IMAGE_STATUSES.has(status)) throw Object.assign(new Error(`APIMart 返回了未知任务状态：${status || "缺失"}`), { code: "PROVIDER_STATUS_INVALID" });
  return { status: "pending", upstreamTaskId: taskId, nextPollMs: apiMartPollIntervalMs(input.submissionStartedAt, pollIntervalMs, runtime.now?.()) };
}

/** Stop claiming new references after failure, but drain every upload already started. */
async function uploadApiMartImageReferences(sources: ImageReference[], baseUrl: string, apiKey: string, runtime: ImageRuntime) {
  const references = new Array<string>(sources.length);
  let nextIndex = 0, failed = false;
  let firstFailure: unknown;
  const uploadNext = async () => {
    while (!failed && nextIndex < sources.length) {
      const index = nextIndex++, source = sources[index]!;
      try {
        references[index] = typeof source !== 'string' || source.startsWith("data:")
          ? await uploadApiMartImage({ baseUrl, apiKey, ...decodeGenerationReference(source), purpose: "image" }, { fetch: runtime.fetch })
          : source;
      } catch (error) {
        if (!failed) { failed = true; firstFailure = error; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, sources.length) }, uploadNext));
  if (failed) throw firstFailure;
  return references;
}

/** Demo/single-request callers retain the blocking convenience API. */
export async function runApiMartImageTask(input: ApiMartImageTaskInput, runtime: ImageRuntime = {}): Promise<string[]> {
  const wait = runtime.sleep || sleep;
  let result = await stepApiMartImageTask(input, runtime);
  const deadline = Date.now() + 15 * 60_000;
  while (result.status === "pending" && Date.now() < deadline) {
    await wait(result.nextPollMs);
    result = await stepApiMartImageTask({ ...input, upstreamTaskId: result.upstreamTaskId, submissionStarted: true }, runtime);
  }
  if (result.status === "completed") return result.urls;
  throw Object.assign(new Error("APIMart 图片任务状态查询超时；可恢复查询原任务，不会重新生成"), { code: "PROVIDER_POLL_TIMEOUT" });
}

function normalizeModelId(kind: ApiMartImageModel, modelId: string) {
  if (kind === "gpt-image-2") return "gpt-image-2";
  if (kind === "midjourney" || kind === "midjourney-blend") return "midjourney";
  return ["nano-banana-2", "gemini-3.1-flash-image-preview-official"].includes(modelId.trim()) ? "gemini-3.1-flash-image-preview-official" : "gemini-3.1-flash-image-preview";
}

function normalizeAspect(value: unknown, kind: ApiMartImageModel) {
  const raw = String(value || "1:1").toLowerCase();
  if (kind === "gpt-image-2" && (GPT_RATIOS.has(raw) || /^[1-9]\d*x[1-9]\d*$/.test(raw))) return raw;
  if (kind === "gemini-3.1-flash-image-preview" && GEMINI_RATIOS.has(raw)) return raw;
  if (kind.startsWith("midjourney") && /^[1-9]\d*:[1-9]\d*$/.test(raw)) return raw;
  throw new Error(`${kind} 不支持尺寸或比例 ${raw}，请按当前模型的参数面板重新选择`);
}

function validateInlineReferences(references: ImageReference[], kind: ApiMartImageModel) {
  const perImage = kind === "gpt-image-2" ? 20 * 1024 * 1024 : kind === "gemini-3.1-flash-image-preview" ? 10 * 1024 * 1024 : 12 * 1024 * 1024;
  let totalBytes = 0;
  for (const reference of references) {
    if (typeof reference !== 'string') {
      if (kind === "gemini-3.1-flash-image-preview" && !["image/jpeg", "image/png", "image/webp"].includes(reference.mimeType)) throw new Error("Gemini 参考图仅支持 JPEG、PNG 或 WebP");
      totalBytes += reference.bytes.byteLength;
      if (reference.bytes.byteLength > perImage) throw new Error(`单张参考图超过 ${perImage / 1024 / 1024} MB，请压缩后重试`);
      continue;
    }
    if (!reference.startsWith("data:")) continue;
    const match = reference.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match) throw new Error("参考图必须为完整的 base64 Data URI");
    if (kind === "gemini-3.1-flash-image-preview" && !["image/jpeg", "image/png", "image/webp"].includes(match[1]!)) throw new Error("Gemini 参考图仅支持 JPEG、PNG 或 WebP");
    const bytes = Buffer.byteLength(match[2]!, "base64");
    totalBytes += bytes;
    if (bytes > perImage) throw new Error(`单张参考图超过 ${perImage / 1024 / 1024} MB，请压缩后重试`);
  }
  if (kind === "gpt-image-2" && totalBytes > 256 * 1024 * 1024) throw new Error("GPT-Image-2 参考图总大小不能超过 256 MB");
}

function normalizeMidjourneySpeed(value: unknown) {
  const speed = String(value || "relax").toLowerCase();
  return speed === "fast" || speed === "turbo" ? speed : "relax";
}

function normalizeGptResolution(value: unknown) {
  const resolution = String(value || "1k").toLowerCase();
  return resolution === "2k" || resolution === "4k" ? resolution : "1k";
}

function normalizeGeminiResolution(value: unknown) {
  const resolution = String(value || "1k").toLowerCase();
  if (resolution === "0.5k") return "0.5K";
  if (resolution === "2k") return "2K";
  if (resolution === "4k") return "4K";
  return "1K";
}

function readTaskId(value: unknown) {
  const record = object(value);
  const data = record.data;
  const first = Array.isArray(data) ? object(data[0]) : object(data);
  return string(first.task_id) || string(first.id) || string(record.task_id) || string(record.id);
}

function readStatus(value: unknown) {
  const record = object(value);
  return (string(object(record.data).status) || string(record.status) || "").toLowerCase();
}

function readOutputUrls(value: unknown): string[] {
  const record = object(value);
  const data = object(record.data);
  const result = object(data.result ?? record.result);
  const images = Array.isArray(result.images) ? result.images : [];
  return images.flatMap((image) => {
    const url = object(image).url;
    return Array.isArray(url) ? url.filter((item): item is string => typeof item === "string" && item.length > 0) : typeof url === "string" ? [url] : [];
  });
}

function readFailureMessage(value: unknown) {
  const record = object(value);
  return string(object(object(record.data).error).message) || string(object(record.error).message) || string(object(record.data).message) || string(record.message);
}

function redactProviderCredential(value: string, apiKey: string) {
  // Redact before truncation so a credential crossing the length boundary cannot leak a prefix.
  const variants = [...new Set([apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)])]
    .filter(Boolean).sort((left, right) => right.length - left.length);
  for (const secret of variants) value = value.split(secret).join("[redacted]");
  return value.slice(0, 500);
}

async function providerMessage(response: Response, apiKey: string) {
  const body = await response.json().catch(() => null);
  return redactProviderCredential(readFailureMessage(body), apiKey) || "上游服务拒绝了请求";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
