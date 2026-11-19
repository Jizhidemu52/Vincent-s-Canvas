import { z } from "zod";
import type {
  AspectRatio, ExplicitOutputPreferences, FieldViolation, FixedFlareQuality, FlareResolution,
  FlareSize, ModelRoleBindings, OutputPreferences, ParameterSource, PixelDimensions,
  PlannerOutputIntent, SettingsSnapshot, SizeMode,
} from "../../shared/image-conversation-contracts";
import {
  exactPixelSizeSchema, explicitOutputPreferencesSchema, fixedFlareQualitySchema,
  flareResolutionSchema, outputPreferencesSchema, pixelDimensionsSchema, plannerOutputIntentSchema,
  settingsSnapshotSchema, uuidSchema,
} from "../../shared/image-conversation-schemas";
import type { PriceSnapshot } from "./billing";

export type ImageOutputPolicyInput = {
  action: "edit" | "generate_new";
  requested?: OutputPreferences;
  intent: PlannerOutputIntent;
  base?: {
    parameters: SettingsSnapshot | null;
    actualDimensions: PixelDimensions | null;
    lockedPreferences?: ExplicitOutputPreferences;
  };
  binding: ModelRoleBindings["imageEdit"] & { providerProtocol: string; enabled: boolean };
  priceSnapshot: Pick<PriceSnapshot,
    "modelId" | "quantity" | "totalCredits" | "totalRmb" | "priceVersion" | "toolKey" | "configurationVersion">;
  limits?: {
    allowedQualities?: FixedFlareQuality[];
    allowedResolutions?: FlareResolution[];
    maxInternalCredits?: number;
  };
};

export type ImageOutputPolicyErrorCode =
  | "OUTPUT_SETTINGS_INVALID" | "MODEL_BINDING_UNAVAILABLE" | "MODEL_CAPABILITY_MISMATCH"
  | "ASSET_NOT_READY" | "PRICE_UNAVAILABLE" | "INSUFFICIENT_CREDITS";

export class ImageOutputPolicyError extends Error {
  constructor(
    readonly code: ImageOutputPolicyErrorCode,
    readonly reason: string,
    message: string,
    readonly fields: FieldViolation[] = [],
    readonly clarificationRequired = false,
  ) {
    super(message);
    this.name = "ImageOutputPolicyError";
  }
}

const qualities: FixedFlareQuality[] = ["low", "medium", "high", "xhigh", "max"];
const resolutions: FlareResolution[] = ["1k", "2k", "4k"];
const preferenceKeys = ["quality", "resolution", "size", "background", "outputFormat"] as const;

// APIMart's documented static-size table: https://docs.apimart.ai/en/api-reference/images/gpt-image-2.6/generation
const nativeSizes: Record<AspectRatio, readonly [readonly [number, number], readonly [number, number], readonly [number, number]]> = {
  "1:1": [[1024, 1024], [2048, 2048], [2880, 2880]],
  "3:2": [[1536, 1024], [2048, 1360], [3520, 2336]],
  "2:3": [[1024, 1536], [1360, 2048], [2336, 3520]],
  "4:3": [[1024, 768], [2048, 1536], [3312, 2480]],
  "3:4": [[768, 1024], [1536, 2048], [2480, 3312]],
  "5:4": [[1280, 1024], [2560, 2048], [3216, 2576]],
  "4:5": [[1024, 1280], [2048, 2560], [2576, 3216]],
  "16:9": [[1536, 864], [2048, 1152], [3840, 2160]],
  "9:16": [[864, 1536], [1152, 2048], [2160, 3840]],
  "2:1": [[2048, 1024], [2688, 1344], [3840, 1920]],
  "1:2": [[1024, 2048], [1344, 2688], [1920, 3840]],
  "21:9": [[2016, 864], [2688, 1152], [3840, 1648]],
  "9:21": [[864, 2016], [1152, 2688], [1648, 3840]],
  "3:1": [[1536, 512], [3072, 1024], [3840, 1280]],
  "1:3": [[512, 1536], [1024, 3072], [1280, 3840]],
};

export function inferImageResolution(dimensions: PixelDimensions): {
  resolution: FlareResolution;
  matchedAspectRatio: AspectRatio;
  nativeDimensions: PixelDimensions;
  exceedsNativeLimit: boolean;
} {
  const { width, height } = validate(pixelDimensionsSchema, dimensions, "base.actualDimensions");
  const ratio = width / height;
  const ratios = Object.keys(nativeSizes) as AspectRatio[];
  const difference = (value: AspectRatio) => {
    const [x, y] = value.split(":").map(Number);
    return Math.abs(Math.log(ratio / (x! / y!)));
  };
  const matchedAspectRatio = ratios.reduce((best, value) => difference(value) < difference(best) ? value : best);
  const sizes = nativeSizes[matchedAspectRatio];
  const fits = ([x, y]: readonly [number, number]) => x >= width && y >= height;
  const fittingIndex = sizes.findIndex(fits);
  const index = fittingIndex < 0 ? 2 : fittingIndex;
  const [nativeWidth, nativeHeight] = sizes[index]!;
  return {
    resolution: resolutions[index]!,
    matchedAspectRatio,
    nativeDimensions: { width: nativeWidth, height: nativeHeight },
    exceedsNativeLimit: fittingIndex < 0,
  };
}

function validate<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ImageOutputPolicyError("OUTPUT_SETTINGS_INVALID", "INVALID_PARAMETERS", "输出参数不符合约定", parsed.error.issues.map(issue => ({
    path: [path, ...issue.path].join("."), message: issue.message,
  })));
}

function conflict(reason: string, message: string, ...paths: string[]): never {
  throw new ImageOutputPolicyError("OUTPUT_SETTINGS_INVALID", reason, message, paths.map(path => ({ path, message })), true);
}

function explicitPreferences(input: ImageOutputPolicyInput) {
  for (const preferences of [input.requested, input.intent?.explicitPreferences]) {
    if (preferences?.background === "transparent" && preferences.outputFormat === "jpeg") {
      conflict("TRANSPARENCY_FORMAT_CONFLICT", "透明背景不能输出 JPEG，请选择 PNG/WebP 或取消透明背景", "requested.background", "requested.outputFormat");
    }
  }
  const requested = validate(outputPreferencesSchema, input.requested ?? { mode: "auto" }, "requested");
  const intent = validate(plannerOutputIntentSchema, input.intent, "intent");
  const merged: OutputPreferences = { mode: requested.mode };
  for (const key of preferenceKeys) {
    const ui = requested[key], text = intent.explicitPreferences?.[key];
    if (ui !== undefined && text !== undefined && ui !== text) {
      conflict("EXPLICIT_PREFERENCES_CONFLICT", "本轮文字要求与高级设置冲突，请明确采用哪一项", `requested.${key}`, `intent.explicitPreferences.${key}`);
    }
    const value = ui ?? text;
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  if (merged.background === "transparent" && merged.outputFormat === "jpeg") {
    conflict("TRANSPARENCY_FORMAT_CONFLICT", "透明背景不能输出 JPEG，请选择 PNG/WebP 或取消透明背景", "requested.background", "requested.outputFormat");
  }
  return { requested: merged, intent };
}

function inheritedLocks(base: ImageOutputPolicyInput["base"]): ExplicitOutputPreferences {
  if (base?.lockedPreferences !== undefined) return validate(explicitOutputPreferencesSchema, base.lockedPreferences, "base.lockedPreferences");
  const snapshot = base?.parameters;
  if (!snapshot) return {};
  const locks: ExplicitOutputPreferences = {};
  for (const key of preferenceKeys) {
    const sourceKey = key === "outputFormat" ? "output_format" : key;
    const effectiveKey = key === "outputFormat" ? "output_format" : key;
    const value = snapshot.requested[key] ?? (snapshot.sourceMap[sourceKey] === "explicit_user" ? snapshot.effective[effectiveKey] : undefined);
    if (value !== undefined) Object.assign(locks, { [key]: value });
  }
  return locks;
}

function sizeMode(size: FlareSize): SizeMode {
  return size === "auto" ? "provider_auto" : size.includes("x") ? "exact_pixels" : "aspect_ratio";
}

function resolveSize(input: ImageOutputPolicyInput, requested: OutputPreferences, intent: PlannerOutputIntent, locks: ExplicitOutputPreferences) {
  let size = requested.size ?? locks.size;
  let source: ParameterSource = requested.size !== undefined ? "explicit_user" : "inherited";
  let mode: SizeMode;
  if (size !== undefined) {
    mode = sizeMode(size);
  } else if (intent.sizeMode === "provider_auto") {
    size = "auto";
    mode = "provider_auto";
    source = "planner_intent";
  } else if (intent.sizeMode === "exact_pixels" || intent.sizeMode === "aspect_ratio") {
    conflict("EXPLICIT_SIZE_REQUIRED", "请明确输出的像素尺寸或宽高比", "intent.sizeMode", "requested.size");
  } else if (input.action === "edit" || intent.sizeMode === "preserve_aspect") {
    if (!input.base) throw new ImageOutputPolicyError("ASSET_NOT_READY", "BASE_IMAGE_REQUIRED", "沿底图比例输出需要可用底图");
    mode = "preserve_aspect";
  } else {
    size = "1:1";
    mode = "aspect_ratio";
    source = "policy";
  }
  return { mode, size, source };
}

function dimensionsForExactSize(size: FlareSize): PixelDimensions {
  const pixels = validate(exactPixelSizeSchema, size, "effective.size");
  const [width, height] = pixels.split("x").map(Number);
  return { width: width!, height: height! };
}

function matchesResolution(size: FlareSize, resolution: FlareResolution) {
  const { width, height } = dimensionsForExactSize(size);
  return Object.values(nativeSizes).some(sizes => {
    const [nativeWidth, nativeHeight] = sizes[resolutions.indexOf(resolution)]!;
    return width === nativeWidth && height === nativeHeight;
  });
}

function validateBinding(binding: ImageOutputPolicyInput["binding"]) {
  if (!binding?.enabled || !uuidSchema.safeParse(binding.modelConfigId).success || !binding.provider?.trim()) {
    throw new ImageOutputPolicyError("MODEL_BINDING_UNAVAILABLE", "BINDING_UNAVAILABLE", "管理员绑定的图像模型不可用");
  }
  if (binding.providerProtocol !== "apimart" || binding.apiModelId !== "gpt-image-2.6-flare") {
    throw new ImageOutputPolicyError("MODEL_CAPABILITY_MISMATCH", "BINDING_MISMATCH", "对话改图需要已绑定的 APIMart Flare 图像模型，不会自动替换模型");
  }
}

function priceEstimate(input: ImageOutputPolicyInput, quality: SettingsSnapshot["effective"]["quality"]): SettingsSnapshot["estimate"] {
  const price = input.priceSnapshot;
  if (!price || price.modelId !== input.binding.modelConfigId || price.quantity !== 1
    || !Number.isSafeInteger(price.totalCredits) || price.totalCredits < 0
    || !Number.isFinite(price.totalRmb) || price.totalRmb < 0
    || !Number.isSafeInteger(price.priceVersion) || price.priceVersion < 0
    || price.configurationVersion !== undefined && (!Number.isSafeInteger(price.configurationVersion) || price.configurationVersion < 0)) {
    throw new ImageOutputPolicyError("PRICE_UNAVAILABLE", "INVALID_INTERNAL_PRICE", "缺少当前绑定模型单张输出的有效内部价格快照");
  }
  const internalRmb = price.totalRmb.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(internalRmb)
    || Math.abs(Number(internalRmb) - price.totalRmb) > Number.EPSILON * Math.abs(price.totalRmb) * 4) {
    throw new ImageOutputPolicyError("PRICE_UNAVAILABLE", "INVALID_INTERNAL_PRICE", "内部价格超出可记录范围");
  }
  return {
    internalCredits: price.totalCredits,
    internalRmb,
    providerEstimatedRmb: null,
    providerActualRmb: null,
    priceSource: `internal:pricing_rule_versions/model_configs${price.configurationVersion !== undefined ? "/tool_configuration" : ""};provider:unavailable`,
    priceVersion: `rules:${price.priceVersion};tool:${price.configurationVersion ?? "none"}`,
    reservationQuality: quality === "auto" ? "max" : quality,
  };
}

function enforceLimits(input: ImageOutputPolicyInput, snapshot: SettingsSnapshot) {
  const limits = input.limits;
  if (!limits) return;
  if (limits.allowedQualities !== undefined) {
    const allowed = validate(z.array(fixedFlareQualitySchema).min(1), limits.allowedQualities, "limits.allowedQualities");
    const quality = snapshot.effective.quality;
    if (quality === "auto" ? qualities.some(value => !allowed.includes(value)) : !allowed.includes(quality)) {
      throw new ImageOutputPolicyError("OUTPUT_SETTINGS_INVALID", "QUALITY_NOT_ALLOWED", "所需画质超出管理员允许范围，不会自动降档");
    }
  }
  if (limits.allowedResolutions !== undefined) {
    const allowed = validate(z.array(flareResolutionSchema).min(1), limits.allowedResolutions, "limits.allowedResolutions");
    const resolution = snapshot.effective.resolution ?? inferImageResolution(dimensionsForExactSize(snapshot.effective.size!)).resolution;
    if (!allowed.includes(resolution)) throw new ImageOutputPolicyError("OUTPUT_SETTINGS_INVALID", "RESOLUTION_NOT_ALLOWED", "所需尺寸超出管理员允许范围，不会自动缩小输出");
  }
  if (limits.maxInternalCredits !== undefined) {
    const maximum = validate(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limits.maxInternalCredits, "limits.maxInternalCredits");
    if (snapshot.estimate.internalCredits > maximum) {
      throw new ImageOutputPolicyError("INSUFFICIENT_CREDITS", "INTERNAL_BUDGET_EXCEEDED", "本轮内部积分价格超过管理员设置的预算，图片任务尚未提交");
    }
  }
}

export function resolveEffectiveImageParameters(input: ImageOutputPolicyInput): SettingsSnapshot {
  validateBinding(input.binding);
  if (input.action !== "edit" && input.action !== "generate_new") {
    throw new ImageOutputPolicyError("OUTPUT_SETTINGS_INVALID", "IMAGE_ACTION_REQUIRED", "只有编辑或新图操作可以解析生图参数");
  }
  if (input.action === "edit" && !input.base) throw new ImageOutputPolicyError("ASSET_NOT_READY", "BASE_IMAGE_REQUIRED", "编辑操作需要可用底图");
  const { requested, intent } = explicitPreferences(input);
  const base = input.action === "edit" ? input.base : undefined;
  const previous = base?.parameters ? validate(settingsSnapshotSchema, base.parameters, "base.parameters") : undefined;
  const locks = inheritedLocks(base);
  const dimensions = base?.actualDimensions ?? previous?.actual?.dimensions;
  const inferred = dimensions ? inferImageResolution(dimensions) : undefined;
  const explicitQuality = requested.quality ?? locks.quality;
  const inheritedQuality = previous?.effective.quality === "auto" ? previous.actual?.quality ?? undefined : previous?.effective.quality;
  const newDraft = input.action === "generate_new" && intent.purpose === "draft";
  let quality = explicitQuality ?? inheritedQuality ?? (newDraft ? "medium" : "high");
  let qualitySource: ParameterSource = requested.quality !== undefined ? "explicit_user"
    : explicitQuality !== undefined || inheritedQuality !== undefined ? "inherited"
      : newDraft ? "planner_intent" : "policy";
  if (explicitQuality === undefined && quality !== "auto" && qualities.indexOf(quality) < qualities.indexOf("high")
    && (intent.purpose === "detail" || intent.purpose === "final" || requested.resolution === "4k")) {
    quality = "high";
    qualitySource = "planner_intent";
  }
  const previousResolution = previous?.resolutionApplied ? previous.effective.resolution : undefined;
  let inheritedResolution = previousResolution ?? inferred?.resolution;
  if (inferred && inheritedResolution && resolutions.indexOf(inferred.resolution) > resolutions.indexOf(inheritedResolution)) {
    inheritedResolution = inferred.resolution;
  }
  const explicitResolution = requested.resolution ?? locks.resolution;
  let resolution = explicitResolution ?? inheritedResolution ?? (newDraft ? "1k" : "2k");
  let resolutionSource: ParameterSource = requested.resolution !== undefined ? "explicit_user"
    : locks.resolution !== undefined || inheritedResolution !== undefined ? "inherited"
      : newDraft ? "planner_intent" : "policy";
  if (explicitResolution === undefined && resolution === "1k" && (intent.purpose === "detail" || intent.purpose === "final")) {
    resolution = "2k";
    resolutionSource = "planner_intent";
  }
  const resolvedSize = resolveSize(input, requested, intent, locks);
  if (resolvedSize.mode === "exact_pixels") {
    if (explicitResolution && !matchesResolution(resolvedSize.size!, explicitResolution)) {
      conflict("EXACT_SIZE_RESOLUTION_CONFLICT", "精确像素尺寸会覆盖分辨率档位，请明确保留像素尺寸还是改用分辨率档位", "requested.size", "requested.resolution");
    }
  }
  const background = requested.background ?? locks.background ?? previous?.effective.background;
  let outputFormat = requested.outputFormat ?? locks.outputFormat ?? previous?.effective.output_format ?? "png";
  let formatSource: ParameterSource = requested.outputFormat !== undefined ? "explicit_user"
    : locks.outputFormat !== undefined || previous?.effective.output_format !== undefined ? "inherited" : "policy";
  if (background === "transparent" && outputFormat === "jpeg") {
    if (requested.outputFormat !== undefined || locks.outputFormat !== undefined) {
      conflict("TRANSPARENCY_FORMAT_CONFLICT", "透明背景与已明确选择的 JPEG 冲突，请选择 PNG/WebP 或取消透明背景", "requested.background", "requested.outputFormat");
    }
    outputFormat = "png";
    formatSource = "policy";
  }
  const snapshot: SettingsSnapshot = {
    policyVersion: "flare-auto-v1",
    sourceMap: {
      model: "admin_binding", quality: qualitySource,
      ...(resolvedSize.mode !== "exact_pixels" ? { resolution: resolutionSource } : {}),
      ...(resolvedSize.size !== undefined ? { size: resolvedSize.source } : {}),
      complexity: "planner_intent",
      ...(background !== undefined ? { background: requested.background !== undefined ? "explicit_user" as const : "inherited" as const } : {}),
      output_format: formatSource, n: "policy",
    },
    requested,
    intent: { purpose: intent.purpose, complexity: intent.complexity, sizeMode: resolvedSize.mode },
    effective: {
      modelConfigId: input.binding.modelConfigId, model: "gpt-image-2.6-flare", n: 1,
      quality, complexity: intent.complexity,
      ...(resolvedSize.mode !== "exact_pixels" ? { resolution } : {}),
      ...(resolvedSize.size !== undefined ? { size: resolvedSize.size } : {}),
      ...(background !== undefined ? { background } : {}),
      output_format: outputFormat,
    },
    resolutionApplied: resolvedSize.mode !== "exact_pixels",
    estimate: priceEstimate(input, quality),
    actual: null,
  };
  enforceLimits(input, snapshot);
  return validate(settingsSnapshotSchema, snapshot, "settings");
}
