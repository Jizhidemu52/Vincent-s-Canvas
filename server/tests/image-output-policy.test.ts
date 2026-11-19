import { describe, expect, test } from "bun:test";
import type { OutputPreferences, SettingsSnapshot } from "../../shared/image-conversation-contracts";
import { settingsSnapshotSchema } from "../../shared/image-conversation-schemas";
import {
  ImageOutputPolicyError, inferImageResolution, resolveEffectiveImageParameters,
  type ImageOutputPolicyInput,
} from "../src/image-output-policy";

const modelConfigId = "22222222-2222-4222-8222-222222222222";

function input(overrides: Partial<ImageOutputPolicyInput> = {}): ImageOutputPolicyInput {
  return {
    action: "generate_new",
    intent: { purpose: "standard", complexity: "medium" },
    binding: { modelConfigId, provider: "existing-apimart-channel", providerProtocol: "apimart", apiModelId: "gpt-image-2.6-flare", enabled: true },
    priceSnapshot: { modelId: modelConfigId, quantity: 1, totalCredits: 5, totalRmb: 1.25, priceVersion: 7, configurationVersion: 3 },
    ...overrides,
  };
}

function generatedBase(requested: OutputPreferences = { mode: "auto" }, actualDimensions = { width: 2048, height: 2048 }) {
  return { parameters: resolveEffectiveImageParameters(input({ requested })), actualDimensions };
}

function captureError(overrides: Partial<ImageOutputPolicyInput>) {
  try {
    resolveEffectiveImageParameters(input(overrides));
  } catch (error) {
    expect(error).toBeInstanceOf(ImageOutputPolicyError);
    return error as ImageOutputPolicyError;
  }
  throw new Error("Expected an image output policy error");
}

describe("conversational image output defaults and inheritance", () => {
  test("product auto defaults to high/2k with one static PNG and no invented actuals", () => {
    const result = resolveEffectiveImageParameters(input());
    expect(result).toMatchObject({
      policyVersion: "flare-auto-v1",
      requested: { mode: "auto" },
      intent: { purpose: "standard", complexity: "medium", sizeMode: "aspect_ratio" },
      effective: { modelConfigId, model: "gpt-image-2.6-flare", quality: "high", resolution: "2k", size: "1:1", n: 1, output_format: "png" },
      sourceMap: { model: "admin_binding", quality: "policy", resolution: "policy", size: "policy", complexity: "planner_intent", n: "policy" },
      resolutionApplied: true, actual: null,
    });
    expect(result.requested).not.toHaveProperty("quality");
    expect(result.effective).not.toHaveProperty("output_compression");
    expect(settingsSnapshotSchema.safeParse(result).success).toBe(true);
  });

  test("only a new draft defaults to medium/1k; an existing 4k edit never silently shrinks", () => {
    const intent = { purpose: "draft", complexity: "low" } as const;
    const draft = resolveEffectiveImageParameters(input({ intent }));
    expect(draft.effective).toMatchObject({ quality: "medium", resolution: "1k", complexity: "low" });
    const base = generatedBase({ mode: "auto", quality: "xhigh", resolution: "4k" }, { width: 2880, height: 2880 });
    const edit = resolveEffectiveImageParameters(input({ action: "edit", base, intent }));
    expect(edit.effective).toMatchObject({ quality: "xhigh", resolution: "4k", complexity: "low" });
    expect(edit.effective).not.toHaveProperty("size");
    expect(edit.intent.sizeMode).toBe("preserve_aspect");
    expect(edit.sourceMap).toMatchObject({ quality: "inherited", resolution: "inherited" });
  });

  test("edits inherit actual 4k upload dimensions and preserve nonstandard aspect ratios by omission", () => {
    for (const actualDimensions of [{ width: 3840, height: 2160 }, { width: 2880, height: 2880 }, { width: 2700, height: 2200 }]) {
      const result = resolveEffectiveImageParameters(input({ action: "edit", base: { parameters: null, actualDimensions } }));
      expect(result.effective.resolution).toBe("4k");
      expect(result.effective).not.toHaveProperty("size");
      expect(result.requested).toEqual({ mode: "auto" });
      expect(result.actual).toBeNull();
    }
  });

  test("unknown edit settings use high/2k, and detail does not mean automatically generating 4k", () => {
    const result = resolveEffectiveImageParameters(input({
      action: "edit", base: { parameters: null, actualDimensions: null },
      intent: { purpose: "detail", complexity: "low" },
    }));
    expect(result.effective).toMatchObject({ quality: "high", resolution: "2k", complexity: "low" });
    expect(result.effective).not.toHaveProperty("size");
  });

  test("unlocked draft quality upgrades for detail while explicit low quality remains a user lock", () => {
    const parameters = resolveEffectiveImageParameters(input({ intent: { purpose: "draft", complexity: "low" } }));
    const base = { parameters, actualDimensions: { width: 1024, height: 1024 } };
    const intent = { purpose: "detail", complexity: "low" } as const;
    expect(resolveEffectiveImageParameters(input({ action: "edit", base, intent })).effective).toMatchObject({ quality: "high", resolution: "2k" });
    expect(resolveEffectiveImageParameters(input({ action: "edit", base: { ...base, lockedPreferences: { quality: "low" } }, intent })).effective.quality).toBe("low");
    expect(resolveEffectiveImageParameters(input({ action: "edit", base: { ...base, lockedPreferences: { resolution: "1k" } }, intent })).effective.resolution).toBe("1k");
  });

  test("an explicit current preference replaces a previous same-field lock", () => {
    const result = resolveEffectiveImageParameters(input({
      action: "edit", base: generatedBase({ mode: "manual", quality: "max", resolution: "4k" }, { width: 2880, height: 2880 }),
      requested: { mode: "auto", quality: "medium", resolution: "1k" },
    }));
    expect(result.effective).toMatchObject({ quality: "medium", resolution: "1k" });
    expect(result.sourceMap).toMatchObject({ quality: "explicit_user", resolution: "explicit_user" });
  });

  test("new generation never inherits a previous branch's settings", () => {
    const result = resolveEffectiveImageParameters(input({ base: generatedBase({ mode: "manual", quality: "max", resolution: "4k", size: "16:9" }) }));
    expect(result.effective).toMatchObject({ quality: "high", resolution: "2k", size: "1:1" });
  });

  test("actual dimensions prevent a generated oversized result from silently shrinking on the next edit", () => {
    const base = { ...generatedBase(), actualDimensions: { width: 2880, height: 2880 }, lockedPreferences: {} };
    expect(resolveEffectiveImageParameters(input({ action: "edit", base })).effective.resolution).toBe("4k");
  });
});

describe("explicit parameter conflicts and size modes", () => {
  test("UI and natural-language explicit values merge without inventing preferences", () => {
    const result = resolveEffectiveImageParameters(input({
      requested: { mode: "manual", resolution: "4k" },
      intent: { purpose: "final", complexity: "medium", explicitPreferences: { resolution: "4k", size: "16:9" } },
    }));
    expect(result.requested).toEqual({ mode: "manual", resolution: "4k", size: "16:9" });
    expect(result.effective).toMatchObject({ resolution: "4k", size: "16:9", quality: "high" });
    expect(result.sourceMap.size).toBe("explicit_user");
  });

  test.each(["quality", "resolution", "size", "background", "outputFormat"] as const)("conflicting explicit %s clarifies", key => {
    const ui = { quality: "high", resolution: "4k", size: "16:9", background: "opaque", outputFormat: "png" };
    const text = { quality: "medium", resolution: "2k", size: "1:1", background: "transparent", outputFormat: "webp" };
    const error = captureError({
      requested: { mode: "manual", [key]: ui[key] },
      intent: { purpose: "standard", complexity: "low", explicitPreferences: { [key]: text[key] } },
    });
    expect(error).toMatchObject({ code: "OUTPUT_SETTINGS_INVALID", reason: "EXPLICIT_PREFERENCES_CONFLICT", clarificationRequired: true });
    expect(error.fields.map(field => field.path)).toEqual([`requested.${key}`, `intent.explicitPreferences.${key}`]);
  });

  test("a new 4k requirement drops an unlocked old exact size instead of appending a misleading resolution", () => {
    const parameters = resolveEffectiveImageParameters(input({ requested: { mode: "manual", size: "1600x1200" } }));
    const result = resolveEffectiveImageParameters(input({
      action: "edit", base: { parameters, actualDimensions: { width: 1600, height: 1200 }, lockedPreferences: {} },
      intent: { purpose: "final", complexity: "low", explicitPreferences: { resolution: "4k" } },
    }));
    expect(result.effective.resolution).toBe("4k");
    expect(result.effective).not.toHaveProperty("size");
    expect(result.resolutionApplied).toBe(true);
  });

  test("an existing explicit exact-size lock conflicts with 4k before image submission", () => {
    const base = generatedBase({ mode: "manual", size: "1600x1200" }, { width: 1600, height: 1200 });
    const error = captureError({ action: "edit", base, requested: { mode: "auto", resolution: "4k" } });
    expect(error).toMatchObject({ reason: "EXACT_SIZE_RESOLUTION_CONFLICT", clarificationRequired: true });
  });

  test("locks from older turns remain enforceable even when the immediate prior snapshot inherited them", () => {
    const initial = generatedBase({ mode: "manual", size: "1600x1200" }, { width: 1600, height: 1200 });
    const prior = resolveEffectiveImageParameters(input({ action: "edit", base: initial }));
    const error = captureError({
      action: "edit", base: { parameters: prior, actualDimensions: initial.actualDimensions, lockedPreferences: { size: "1600x1200" } },
      requested: { mode: "auto", resolution: "4k" },
    });
    expect(error.reason).toBe("EXACT_SIZE_RESOLUTION_CONFLICT");
  });

  test("explicitly replacing the old size clears its lock and literal auto is distinct from omitted size", () => {
    const base = generatedBase({ mode: "manual", size: "1600x1200" }, { width: 1600, height: 1200 });
    for (const size of ["16:9", "auto"] as const) {
      const result = resolveEffectiveImageParameters(input({ action: "edit", base, requested: { mode: "auto", resolution: "4k", size } }));
      expect(result.effective).toMatchObject({ size, resolution: "4k" });
      expect(result.intent.sizeMode).toBe(size === "auto" ? "provider_auto" : "aspect_ratio");
    }
  });

  test("exact pixels omit resolution and record that upstream would ignore it", () => {
    for (const size of ["1600x1200", "3840x2160", "2880x2880", "1280x512"] as const) {
      const result = resolveEffectiveImageParameters(input({ requested: { mode: "manual", size } }));
      expect(result.effective.size).toBe(size);
      expect(result.effective).not.toHaveProperty("resolution");
      expect(result.sourceMap).not.toHaveProperty("resolution");
      expect(result.resolutionApplied).toBe(false);
      expect(result.intent.sizeMode).toBe("exact_pixels");
    }
  });

  test("a matching named resolution and exact pixel pair is accepted but not sent as two effective controls", () => {
    const result = resolveEffectiveImageParameters(input({ requested: { mode: "manual", size: "3840x2160", resolution: "4k" } }));
    expect(result.requested).toMatchObject({ size: "3840x2160", resolution: "4k" });
    expect(result.effective).not.toHaveProperty("resolution");
    expect(result.resolutionApplied).toBe(false);
  });

  test.each(["0x1024", "1025x1024", "4096x2048", "3840x1024", "512x512", "3840x3840", "1e3x1024", "1600X1200", "1024.0x1024"])("rejects invalid exact size %s", size => {
    const error = captureError({ requested: { mode: "manual", size: size as OutputPreferences["size"] } });
    expect(error.code).toBe("OUTPUT_SETTINGS_INVALID");
  });

  test("edit requires a base and an explicit size mode cannot fabricate missing dimensions", () => {
    expect(captureError({ action: "edit" }).code).toBe("ASSET_NOT_READY");
    expect(captureError({ intent: { purpose: "standard", complexity: "low", sizeMode: "preserve_aspect" } }).code).toBe("ASSET_NOT_READY");
    expect(captureError({ intent: { purpose: "standard", complexity: "low", sizeMode: "exact_pixels" } }).reason).toBe("EXPLICIT_SIZE_REQUIRED");
  });

  test("explicit size takes precedence over an inferred planner size mode", () => {
    const result = resolveEffectiveImageParameters(input({ requested: { mode: "manual", size: "16:9" }, intent: { purpose: "standard", complexity: "low", sizeMode: "preserve_aspect" } }));
    expect(result.intent.sizeMode).toBe("aspect_ratio");
  });
});

describe("documented upload-size inference", () => {
  test.each([
    [1024, 1024, "1k"], [2048, 2048, "2k"], [2880, 2880, "4k"],
    [2048, 1360, "2k"], [1360, 2048, "2k"], [3312, 2480, "4k"],
    [2560, 2048, "2k"], [2048, 2560, "2k"], [3840, 2160, "4k"],
    [2688, 1344, "2k"], [1344, 2688, "2k"], [3840, 1648, "4k"],
    [1648, 3840, "4k"], [3072, 1024, "2k"], [1024, 3072, "2k"],
  ] as const)("%sx%s maps to documented %s without calling it an actual output", (width, height, resolution) => {
    expect(inferImageResolution({ width, height })).toMatchObject({ resolution, nativeDimensions: { width, height }, exceedsNativeLimit: false });
  });

  test("nonstandard upload dimensions preserve ratio at execution and infer a sufficient tier", () => {
    expect(inferImageResolution({ width: 577, height: 591 })).toMatchObject({ resolution: "1k", matchedAspectRatio: "1:1" });
    expect(inferImageResolution({ width: 2049, height: 2050 })).toMatchObject({ resolution: "4k", matchedAspectRatio: "1:1" });
    const result = resolveEffectiveImageParameters(input({ action: "edit", base: { parameters: null, actualDimensions: { width: 577, height: 591 } } }));
    expect(result.effective).not.toHaveProperty("size");
  });

  test("oversized uploads expose the native 4k ceiling without claiming source pixel preservation", () => {
    expect(inferImageResolution({ width: 4096, height: 4096 })).toEqual({
      resolution: "4k", matchedAspectRatio: "1:1", nativeDimensions: { width: 2880, height: 2880 }, exceedsNativeLimit: true,
    });
    const result = resolveEffectiveImageParameters(input({ action: "edit", base: { parameters: null, actualDimensions: { width: 4096, height: 4096 } } }));
    expect(result.effective.resolution).toBe("4k");
    expect(result.actual).toBeNull();
  });

  test("invalid decoded dimensions cannot become a silent fallback", () => {
    for (const width of [0, -1, 1.5, NaN, Infinity]) expect(() => inferImageResolution({ width, height: 1024 })).toThrow(ImageOutputPolicyError);
  });
});

describe("format, price and binding boundaries", () => {
  test("transparent background defaults to PNG; an explicit incompatible JPEG clarifies", () => {
    expect(resolveEffectiveImageParameters(input({ requested: { mode: "auto", background: "transparent" } })).effective.output_format).toBe("png");
    expect(resolveEffectiveImageParameters(input({ requested: { mode: "auto", background: "transparent", outputFormat: "webp" } })).effective.output_format).toBe("webp");
    expect(captureError({ requested: { mode: "manual", background: "transparent", outputFormat: "jpeg" } })).toMatchObject({ reason: "TRANSPARENCY_FORMAT_CONFLICT", clarificationRequired: true });
    expect(captureError({ requested: { mode: "manual", outputFormat: "jpeg" }, intent: { purpose: "standard", complexity: "low", explicitPreferences: { background: "transparent" } } }).clarificationRequired).toBe(true);
  });

  test("an inherited unlocked JPEG can become PNG for transparency but an old user lock cannot", () => {
    const base = generatedBase({ mode: "manual", outputFormat: "jpeg" });
    const requested = { mode: "auto", background: "transparent" } as const;
    expect(captureError({ action: "edit", base, requested }).reason).toBe("TRANSPARENCY_FORMAT_CONFLICT");
    expect(resolveEffectiveImageParameters(input({ action: "edit", base: { ...base, lockedPreferences: {} }, requested })).effective.output_format).toBe("png");
  });

  test("explicit provider quality:auto reserves max without inventing actual quality or supplier price", () => {
    const result = resolveEffectiveImageParameters(input({ requested: { mode: "auto", quality: "auto" } }));
    expect(result.effective.quality).toBe("auto");
    expect(result.estimate).toEqual({
      internalCredits: 5, internalRmb: "1.25", providerEstimatedRmb: null, providerActualRmb: null,
      priceSource: "internal:pricing_rule_versions/model_configs/tool_configuration;provider:unavailable",
      priceVersion: "rules:7;tool:3", reservationQuality: "max",
    });
    expect(result.actual).toBeNull();
  });

  test.each([0, 100, 0.000001, 0.1 + 0.2])("internal RMB %s is a decimal string, never a supplier estimate", totalRmb => {
    const result = resolveEffectiveImageParameters(input({ priceSnapshot: { ...input().priceSnapshot, totalRmb } }));
    expect(result.estimate.internalRmb).toBe(totalRmb === 0.1 + 0.2 ? "0.3" : String(totalRmb));
    expect(result.estimate.providerEstimatedRmb).toBeNull();
  });

  test("prices must be for one image and this exact configured model", () => {
    for (const priceSnapshot of [
      { ...input().priceSnapshot, modelId: "other" }, { ...input().priceSnapshot, quantity: 2 },
      { ...input().priceSnapshot, totalCredits: -1 }, { ...input().priceSnapshot, totalRmb: NaN },
      { ...input().priceSnapshot, totalRmb: 0.000000001 }, { ...input().priceSnapshot, totalRmb: 1e21 },
    ]) expect(captureError({ priceSnapshot }).code).toBe("PRICE_UNAVAILABLE");
  });

  test("unknown edit settings remain policy defaults even if the planner labels the turn draft", () => {
    const result = resolveEffectiveImageParameters(input({
      action: "edit", base: { parameters: null, actualDimensions: null },
      intent: { purpose: "draft", complexity: "low" },
    }));
    expect(result.effective).toMatchObject({ quality: "high", resolution: "2k" });
    expect(result.sourceMap).toMatchObject({ quality: "policy", resolution: "policy" });
  });

  test("only a prior user auto lock continues auto; otherwise inherit the provider's reported actual quality", () => {
    const base = generatedBase({ mode: "manual", quality: "auto" });
    expect(resolveEffectiveImageParameters(input({ action: "edit", base })).effective.quality).toBe("auto");
    base.parameters.actual = {
      quality: "xhigh", dimensions: base.actualDimensions, outputFormat: "png", mimeType: "image/png",
      providerActualRmb: null, usage: null,
    };
    expect(resolveEffectiveImageParameters(input({ action: "edit", base: { ...base, lockedPreferences: {} } })).effective.quality).toBe("xhigh");
    base.parameters.actual.quality = null;
    expect(resolveEffectiveImageParameters(input({ action: "edit", base: { ...base, lockedPreferences: {} } })).effective.quality).toBe("high");
  });

  test("disabled or wrong model bindings never silently switch model or provider", () => {
    expect(captureError({ binding: { ...input().binding, enabled: false } }).code).toBe("MODEL_BINDING_UNAVAILABLE");
    expect(captureError({ binding: { ...input().binding, providerProtocol: "openai" } }).code).toBe("MODEL_CAPABILITY_MISMATCH");
    expect(captureError({ binding: { ...input().binding, apiModelId: "mai-image-2.6-flash" as "gpt-image-2.6-flare" } }).code).toBe("MODEL_CAPABILITY_MISMATCH");
  });

  test("admin limits block rather than silently downgrade, including exact-pixel bypasses", () => {
    expect(captureError({ limits: { allowedQualities: ["medium"] } }).reason).toBe("QUALITY_NOT_ALLOWED");
    expect(captureError({ requested: { mode: "auto", quality: "auto" }, limits: { allowedQualities: ["high", "max"] } }).reason).toBe("QUALITY_NOT_ALLOWED");
    expect(captureError({ requested: { mode: "auto", size: "3840x2160" }, limits: { allowedResolutions: ["1k", "2k"] } }).reason).toBe("RESOLUTION_NOT_ALLOWED");
    expect(captureError({ limits: { maxInternalCredits: 4 } })).toMatchObject({ code: "INSUFFICIENT_CREDITS", reason: "INTERNAL_BUDGET_EXCEEDED" });
    expect(resolveEffectiveImageParameters(input({ limits: { maxInternalCredits: 5 } })).estimate.internalCredits).toBe(5);
  });

  test("strict input rejects extra outputs, animation, compression or client model selection", () => {
    for (const extra of [{ n: 4 }, { outputFormat: "gif" }, { outputFormat: "svg" }, { output_compression: 90 }, { modelConfigId: "other" }]) {
      expect(captureError({ requested: { mode: "auto", ...extra } as OutputPreferences }).code).toBe("OUTPUT_SETTINGS_INVALID");
    }
  });

  test("resolution is deterministic, detached from inputs, and never mutates earlier evidence", () => {
    const initial = input({ action: "edit", base: generatedBase({ mode: "manual", quality: "xhigh", resolution: "4k" }, { width: 2880, height: 2880 }) });
    const original = structuredClone(initial);
    const result = resolveEffectiveImageParameters(initial);
    expect(resolveEffectiveImageParameters(initial)).toEqual(result);
    result.requested.mode = "manual";
    result.effective.quality = "low";
    result.estimate.internalCredits = 999;
    expect(initial).toEqual(original);
    expect((initial.base!.parameters as SettingsSnapshot).effective.quality).toBe("xhigh");
  });
});
