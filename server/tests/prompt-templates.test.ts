import { describe, expect, test } from "bun:test";

import {
  operationForPromptTool,
  pricePromptModel,
  promptSnapshotSchema,
  quantityFromParameters,
  resolvePromptModel,
  validateReplacementSelection,
  type PromptModelCandidate,
} from "../src/prompt-templates";

const model = (input: Partial<PromptModelCandidate> & Pick<PromptModelCandidate, "id">): PromptModelCandidate => ({
  id: input.id,
  name: input.name ?? input.id,
  modelId: input.modelId ?? input.id,
  capabilities: input.capabilities ?? ["generate"],
  creditCost: input.creditCost ?? 4,
  rmbCost: input.rmbCost ?? 0.4,
  enabled: input.enabled ?? true,
  providerEnabled: input.providerEnabled ?? true,
  replacementModelConfigId: input.replacementModelConfigId ?? null,
});

describe("prompt template snapshots", () => {
  test("normalizes reproducible inputs without retaining duplicate tags or references", () => {
    const result = promptSnapshotSchema.parse({
      title: "  白底商品图  ", prompt: "  保持服装结构，生成白底商品图  ", targetTool: "image-edit",
      tags: ["商品图", "商品图"], referenceAssetIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      parameters: { width: 1024, height: 1024, quantity: 3 },
    });
    expect(result.title).toBe("白底商品图");
    expect(result.tags).toEqual(["商品图"]);
    expect(result.referenceAssetIds).toHaveLength(1);
    expect(quantityFromParameters(result.parameters)).toBe(3);
  });

  test("rejects empty, oversized and malformed snapshot fields", () => {
    expect(() => promptSnapshotSchema.parse({ title: "", prompt: "x", targetTool: "image-edit" })).toThrow();
    expect(() => promptSnapshotSchema.parse({ title: "x", prompt: "x".repeat(20_001), targetTool: "image-edit" })).toThrow();
    expect(() => promptSnapshotSchema.parse({ title: "x", prompt: "x", targetTool: "unknown" })).toThrow();
    expect(() => promptSnapshotSchema.parse({ title: "x", prompt: "x", targetTool: "image-edit", parameters: { raw: "x".repeat(20_001) } })).toThrow();
  });

  test("maps every target tool to the server billing operation and bounds quantity", () => {
    expect(operationForPromptTool("detail-enhance")).toBe("upscale");
    expect(operationForPromptTool("angle-control")).toBe("inpaint");
    expect(operationForPromptTool("batch-edit")).toBe("batch_image");
    expect(quantityFromParameters({ count: 100 })).toBe(100);
    expect(quantityFromParameters({ quantity: 0 })).toBe(1);
    expect(quantityFromParameters({ quantity: 101 })).toBe(1);
    expect(quantityFromParameters({ quantity: "3" })).toBe(1);
  });
});

describe("prompt model and current price resolution", () => {
  test("keeps a currently enabled compatible historical model", () => {
    const historical = model({ id: "historical" });
    const result = resolvePromptModel(historical.id, "image_generation", [historical]);
    expect(result.selected?.id).toBe("historical");
    expect(result.modelChanged).toBe(false);
  });

  test("uses an explicit usable replacement when the historical model is disabled", () => {
    const historical = model({ id: "historical", enabled: false, replacementModelConfigId: "replacement" });
    const replacement = model({ id: "replacement" });
    const result = resolvePromptModel(historical.id, "image_generation", [historical, replacement]);
    expect(result.selected?.id).toBe("replacement");
    expect(result).toMatchObject({ modelChanged: true, reason: "replacement" });
  });

  test("does not silently choose an alternative when replacement is unavailable or cyclic", () => {
    const historical = model({ id: "a", enabled: false, replacementModelConfigId: "b" });
    const broken = model({ id: "b", enabled: false, replacementModelConfigId: "a" });
    const alternative = model({ id: "c" });
    const result = resolvePromptModel("a", "image_generation", [historical, broken, alternative]);
    expect(result.selected).toBeNull();
    expect(result.alternatives.map((item) => item.id)).toEqual(["c"]);
    expect(validateReplacementSelection("a", "a")).toBe(false);
    expect(validateReplacementSelection("a", "b", ["b"])).toBe(false);
  });

  test("calculates with the current operation and model price instead of historical price", () => {
    expect(pricePromptModel(model({ id: "m", creditCost: 6, rmbCost: 0.25 }), {
      operationType: "image_generation", credits: 10, rmbCost: 0.8, version: 7,
    }, 2)).toMatchObject({ totalCredits: 32, totalRmb: 2.1, priceVersion: 7 });
  });
});
