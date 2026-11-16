import { describe, expect, test } from "bun:test";
import { seedream55TaskOptions } from "../../shared/seedream55-options";
import { buildApiMartImageRequest, stepApiMartImageTask } from "../src/apimart-image";
import { layerStudioCostEstimate } from "../src/layer-studio-billing";

describe("ordinary Doubao parameter boundary", () => {
  test.each(["1k", "1.5k", "2k"])("normalizes %s with adaptive framing without mutating the draft", resolution => {
    const parameters = { tool: "image", size: "auto", resolution, count: 1, n: 1 };
    expect(seedream55TaskOptions(parameters, "围巾", 0)).toEqual({ size: resolution.toUpperCase(), n: 1 });
    expect(parameters).toEqual({ tool: "image", size: "auto", resolution, count: 1, n: 1 });
    const ratio = seedream55TaskOptions({ ...parameters, size: "16:9" }, "围巾", 10);
    expect(ratio).toMatchObject({ size: "16:9", n: 1 });
    expect(String(ratio.resolution)).toBe(resolution.toUpperCase());
  });
  test("task bookkeeping survives locally but is absent from provider payload", () => {
    const parameters = { tool: "canvas-edit", size: "auto", resolution: "1.5k", n: 1, count: 1,
      inputArchive: { prompt: "原始要求", config: { model: "private-config" } }, promptOptimization: { compilationId: "private-id" },
      promptExclusions: { negativePrompt: "不要文字" }, imageAgentProfile: "canvas-assistant",
      designRequirements: { subject: "围巾" }, designDocumentCatalog: [{ id: "private-doc" }], background: "transparent", output_format: "png" };
    const payload = buildApiMartImageRequest({ modelId: "seedream-5-5", prompt: "围巾，不要文字", parameters }).payload;
    expect(payload).toEqual({ model: "seedream-5-5", prompt: "围巾，不要文字", n: 1, size: "1.5K", background: "transparent", output_format: "png" });
    expect(parameters.inputArchive.prompt).toBe("原始要求");
  });
  test.each([
    { tool: "layer-studio" }, { tool: "canvas-mask-edit" }, { tool: "gpt-chat" }, { tool: "midjourney-blend" },
    { count: 2 }, { n: 2 }, { quality: "high" }, { resolution: "4k" }, { resolution: "auto" },
    { layer_decomposition: false }, { layer_decomposition: true }, { layer_decomposition_options: { max_images: 2 } },
    { inputArchive: { maskReferenceIndex: 0 } }, { inputArchive: { markupReferenceIndex: 1 } },
    { mask: true }, { markup_image: "https://invalid.example/markup" }, { image_urls: [] }, { negative_prompt: "不得静默丢弃" },
    { background: "transparent", output_format: "jpeg" }, { output_format: "webp" }, { size: "1024x1024", resolution: "1k" },
  ])("rejects unsupported parameters %j", value => {
    expect(() => seedream55TaskOptions({ tool: "image", ...value }, "围巾", 1)).toThrow();
  });
  test("invalid inputs never create provider POST or silently accept an eleventh reference", async () => {
    let requests = 0;
    await expect(stepApiMartImageTask({ baseUrl: "https://provider.invalid/v1", apiKey: "fixture", modelId: "seedream-5-5", prompt: "围巾",
      parameters: { tool: "image", size: "auto", resolution: "4k" } }, { fetch: async () => { requests++; return Response.json({}); } })).rejects.toThrow();
    expect(requests).toBe(0);
    expect(() => seedream55TaskOptions({ tool: "image" }, "围巾", 11)).toThrow();
    expect(() => seedream55TaskOptions({ tool: "image" }, " ", 0)).toThrow();
  });
  test("ordinary adaptive estimates use normalized tier and input count", () => {
    const rates = { inputRmb: .01, lowOutputRmb: .1, highOutputRmb: .2, version: 4 };
    expect(layerStudioCostEstimate({ tool: "canvas-batch", size: "auto", resolution: "1.5k", n: 1 }, 2, rates)).toMatchObject({ maximumOutputs: 1, estimatedPrecharge: .12, prechargeBand: "low" });
    expect(layerStudioCostEstimate({ tool: "image-edit", size: "auto", resolution: "2k", n: 1 }, 1, rates)).toMatchObject({ maximumOutputs: 1, estimatedPrecharge: .21, prechargeBand: "high" });
  });
});
