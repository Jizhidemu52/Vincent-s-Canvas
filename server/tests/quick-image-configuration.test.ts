import { describe, expect, test } from "bun:test";
import { isQuickImageEligibleModel, validateQuickImageConfiguration } from "../src/quick-image-configuration";
import { prepareQuickImageTask, QUICK_IMAGE_SNAPSHOT, type QuickImageInput, type QuickImageSnapshot } from "../src/quick-image-tools";
import { quickImageTaskTarget } from "../../shared/quick-image-tools";

const id = "10000000-0000-4000-8000-000000000001";
const model = (modelId: string) => ({ modelId, protocol: "apimart", capabilities: ["edit"], enabled: true, providerEnabled: true, workflowConfigId: null });
const configuration = (parameters: Record<string, unknown>) => ({ modelConfigId: id, prompt: "Keep the selected product unchanged.", parameters });

describe("quick image model selection and safe parameter boundaries", () => {
  for (const [modelId, parameters] of [
    ["mai-image-2.6-flash", { web_grounding: false }],
    ["gemini-nano-banana-2.1", { resolution: "4k", size: "auto" }],
    ["gpt-image-2.5-flare", { resolution: "2k", quality: "high", output_format: "webp", output_compression: 90 }],
    ["gpt-image-2.6-flare", { resolution: "2k", quality: "medium", background: "opaque", output_format: "png", size: "auto" }],
    ["gpt-image-2.6-sunburst", { resolution: "1k", complexity: "high", moderation: "auto" }],
    ["gpt-image-2-ext", { resolution: "2k", size: "auto", official_fallback: true }],
    ["gemini-3.1-flash-image-preview-official", { resolution: "0.5k", size: "auto", googleSearch: true }],
    ["grok-imagine-image-2.0", { resolution: "2k", aspect_ratio: "auto", nsfw_check: true }],
  ] as const) test(`${modelId} is selectable through its actual edit adapter`, () => {
    expect(isQuickImageEligibleModel(model(modelId))).toBe(true);
    expect(validateQuickImageConfiguration("hd-upscale", configuration(parameters), model(modelId)).parameters).toEqual(parameters);
  });

  test("ineligible protocols, disabled models, workflows and multi-reference-only adapters are never selectable", () => {
    for (const target of [model("midjourney"), model("midjourney-blend"), model("unknown"), { ...model("gpt-image-2"), protocol: "openai" },
      { ...model("gpt-image-2"), enabled: false }, { ...model("gpt-image-2"), providerEnabled: false }, { ...model("gpt-image-2"), capabilities: ["generate"] },
      { ...model("gpt-image-2"), workflowConfigId: id }]) expect(isQuickImageEligibleModel(target)).toBe(false);
  });

  test("stringified booleans, empty size and nested/unrecognized values cannot silently fall through adapter defaults", () => {
    for (const parameters of [{ googleSearch: "true" }, { officialFallback: 1 }, { googleImageSearch: "false" }, { size: false }, { resolution: "" }, { size: " " }, { parameters: {} }, { size: ["auto"] }]) {
      expect(() => validateQuickImageConfiguration("hd-upscale", configuration(parameters), model("gemini-3.1-flash-image-preview"))).toThrow();
    }
    expect(validateQuickImageConfiguration("remove-background", configuration({ background: "transparent" }), model("gpt-image-2.6-flare")).parameters).toEqual({ background: "transparent", output_format: "png" });
    expect(() => validateQuickImageConfiguration("item-extract", configuration({ background: "transparent" }), model("gpt-image-2.6-flare"))).toThrow("白底商品图");
  });

  test("all background entry points use native transparent PNG controls without a matte contract", () => {
    const snapshot: QuickImageSnapshot = Object.freeze({ ...configuration({ resolution: "1k", quality: "high" }), action: "remove-background", modelId: "gpt-image-2.6-flare", configurationVersion: 6 });
    const prepared = prepareQuickImageTask({ ...quickImageTaskTarget("remove-background"), sourceUrls: ["owned"], prompt: "FORGED", parameters: { quickImageAction: "remove-background", n: 99 } }, snapshot);
    expect(prepared.prompt).toContain("finished full-color subject image"); expect(prepared.prompt).not.toContain("original RGB pixels"); expect(prepared.prompt).toContain(snapshot.prompt); expect(prepared.prompt).not.toContain("FORGED");
    expect(prepared.parameters).toMatchObject({ n: 1, count: 1, resolution: "1k", background: "transparent", output_format: "png", quickImage: { recipeVersion: 2, configurationVersion: 6 } });
    expect(JSON.stringify(prepared)).not.toContain(String(QUICK_IMAGE_SNAPSHOT));
  });

  test("accepts transparent full-color output instructions instead of enforcing selection-only prompts", () => {
    for (const prompt of [
      "Keep the main subject unchanged. Export as a PNG image with a transparent background.",
      "Return a full-color photograph with the background removed.",
      "保留主要商品，输出透明背景 PNG。",
    ]) {
      const draft = { ...configuration({}), prompt };
      expect(validateQuickImageConfiguration("remove-background", draft, model("gpt-image-2.6-flare")).prompt).toBe(prompt);
      const snapshot: QuickImageSnapshot = { ...draft, action: "remove-background", modelId: "gpt-image-2.6-flare", configurationVersion: 4 };
      const prepared = prepareQuickImageTask<QuickImageInput>({ ...quickImageTaskTarget("remove-background"), sourceUrls: ["owned"], parameters: { quickImageAction: "remove-background" } }, snapshot);
      expect(prepared.prompt).toContain(prompt);
      expect(prepared.parameters).toMatchObject({ background: "transparent", output_format: "png" });
    }
  });

  test("old opaque parameters become direct transparent PNG without changing the model, quality or caller data", () => {
    const prompt = "Keep the transparent lace and fine fibers of the sweater in the original position.";
    const draft = { modelConfigId: id, parameters: { background: "opaque", output_format: "jpeg", resolution: "2k", quality: "high" }, prompt };
    const before = structuredClone(draft);
    for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"]) {
      const validated = validateQuickImageConfiguration("remove-background", draft, model(modelId));
      expect(validated).toEqual({ ...draft, parameters: { ...draft.parameters, background: "transparent", output_format: "png" } });
      const snapshot: QuickImageSnapshot = { ...validated, action: "remove-background", modelId, configurationVersion: 8 };
      for (const canvas of [false, true]) {
        const prepared = prepareQuickImageTask<QuickImageInput>({ ...quickImageTaskTarget("remove-background", canvas), sourceUrls: ["owned"], parameters: { quickImageAction: "remove-background" } }, snapshot);
        expect(prepared.parameters).toMatchObject({ background: "transparent", output_format: "png", quality: "high", resolution: "2k", quickImage: { recipeVersion: 2, configurationVersion: 8 } });
        expect(prepared.prompt).toContain(prompt);
        expect(prepared.prompt).not.toContain("fully opaque (alpha 255 everywhere)");
      }
    }
    expect(draft).toEqual(before);
    const promptOnly = validateQuickImageConfiguration("remove-background", configuration({ web_grounding: false }), model("mai-image-2.6-flash"));
    expect(promptOnly.parameters).toEqual({ web_grounding: false });
  });
});
