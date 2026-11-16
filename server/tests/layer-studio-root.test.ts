import { describe, expect, test } from "bun:test";
import { layerStudioCostEstimate, settleLayerStudioCost } from "../src/layer-studio-billing";
import { layerStudioBindingValid } from "../src/layer-studio-policy";
import { isFeaturedModelCandidate, presentAdminModel, presentPublicModel, selectCreativeModels } from "../src/model-presentation";
import { MARK_IMAGE_PROVIDER_ID } from "../../shared/mark-image-models";
import { toolDefinitions } from "../../shared/feature-catalog";

const rates = { inputRmb: 0.01, lowOutputRmb: 0.1, highOutputRmb: 0.2, version: 7 };
describe("dedicated layer cost accounting", () => {
  test.each([
    [{}, "high", 0.21], [{ size: "1K" }, "low", 0.11], [{ size: "1.5K" }, "low", 0.11],
    [{ size: "2K" }, "high", 0.21], [{ size: "auto" }, "high", 0.21],
    [{ size: "16x9", resolution: "1K" }, "low", 0.11], [{ size: "16:9" }, "high", 0.21],
    [{ size: "1500x1740" }, "low", 0.11], [{ size: "1500x1741" }, "high", 0.21],
  ] as const)("precharge %j uses the requested tier or exact pixel threshold", (parameters, band, expected) => {
    expect(layerStudioCostEstimate(parameters, 1, rates)).toMatchObject({ estimatedPrecharge: expected, prechargeBand: band,
      sourceCount: 1, maximumOutputs: 1, currency: "CNY", providerCharge: "unverified" });
  });
  test("layer size wins over alias, default30 includes base, first reference is charged", () => {
    expect(layerStudioCostEstimate({ layer_decomposition: true }, 1, rates).estimatedPrecharge).toBe(6.01);
    expect(layerStudioCostEstimate({ layer_decomposition: true, size: "1K", resolution: "2K" }, 1, rates).estimatedPrecharge).toBe(3.01);
    expect(layerStudioCostEstimate({ layer_decomposition: true, resolution: "1.5K", layer_decomposition_options: { max_images: 100 } }, 1, rates).estimatedPrecharge).toBe(10.01);
  });
  test("settlement uses each actual original size, freezes prices and does not claim provider payment", () => {
    const held = layerStudioCostEstimate({ layer_decomposition: true, size: "2K", layer_decomposition_options: { max_images: 8 } }, 1, rates);
    const actual = settleLayerStudioCost(held, [{ width: 1000, height: 1000 }, { width: 2048, height: 2048 }]);
    expect(actual).toMatchObject({ estimatedPrecharge: 1.61, settledEstimate: 0.31, settledOutputCount: 2,
      actualOutputPixels: [1_000_000, 4_194_304], providerCharge: "unverified", version: 7 });
    expect(held.settledEstimate).toBeUndefined();
  });
  test("invalid count, mixed parameters, missing reference price and absent dimensions cannot silently produce a quote", () => {
    expect(() => layerStudioCostEstimate({ layer_decomposition: true }, 0, rates)).toThrow();
    expect(() => layerStudioCostEstimate({ layer_decomposition: true, background: "auto" }, 1, rates)).toThrow();
    expect(() => layerStudioCostEstimate({}, 0, { ...rates, inputRmb: Number.NaN })).toThrow();
    const held = layerStudioCostEstimate({}, 0, rates);
    expect(() => settleLayerStudioCost(held, [])).toThrow();
    expect(() => settleLayerStudioCost(held, [{ width: 0, height: 1024 }])).toThrow();
    expect(() => settleLayerStudioCost(held, [{ width: 1024, height: 1024 }, { width: 1024, height: 1024 }])).toThrow();
  });
});

describe("layer model boundaries", () => {
  const model = { id: "11111111-1111-4111-8111-111111111111", modelId: "seedream-5-5", providerId: MARK_IMAGE_PROVIDER_ID,
    name: "Secret Model", providerName: "Secret Provider", protocol: "apimart", workflowConfigId: null,
    capabilities: ["generate", "edit"], publicNumber: 15, creditCost: 3, rmbCost: 0 };
  test.each(["designer", "department_admin", "super_admin"])("ordinary creation uses Doubao label without provider identity for %s", role => {
    const projection = presentPublicModel(model, role);
    expect(projection).toMatchObject({ name: "豆包生图", publicName: "豆包生图", modelId: model.id, modelIdentityHidden: true, imageParameterProfile: "seedream55", imageSupportsMask: false, imageSupportsOfficialFallback: false });
    expect(JSON.stringify(projection)).not.toMatch(/seedream-5-5|apimart|Secret Model|Secret Provider/i);
  });
  test("ordinary selectors include it without changing featured defaults or layer-specific binding", () => {
    expect(presentAdminModel(model)).toMatchObject({ modelId: "seedream-5-5" });
    expect(selectCreativeModels([model])).toEqual([model]);
    expect(isFeaturedModelCandidate(model)).toBe(false);
    expect(layerStudioBindingValid("layer-studio", model)).toBe(true);
    for (const tool of toolDefinitions) {
      const ordinaryImage = tool.operations.some(operation => ["image_generation", "inpaint", "batch_image", "upscale", "seamless_stitch"].includes(operation));
      expect(layerStudioBindingValid(tool.toolKey, model)).toBe(ordinaryImage && tool.toolKey !== "canvas-mask-edit" && tool.toolKey !== "midjourney-blend");
    }
    expect(selectCreativeModels([{ ...model, protocol: "openai" }, { ...model, workflowConfigId: "workflow" }])).toEqual([]);
    expect(layerStudioBindingValid("layer-studio", { ...model, workflowConfigId: "workflow" })).toBe(false);
    expect(layerStudioBindingValid("layer-studio", { ...model, protocol: "openai" })).toBe(false);
    expect(layerStudioBindingValid("layer-studio", { ...model, modelId: "other" })).toBe(false);
  });
});
