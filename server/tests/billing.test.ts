import { describe, expect, test } from "bun:test";
import { calculatePrice, modelSupportsOperation } from "../src/billing";

describe("billing price snapshots", () => {
  test("combines operation and model prices for every output", () => {
    expect(
      calculatePrice({
        operationType: "image_generation",
        operationCredits: 8,
        operationRmb: 0.8,
        modelId: "model-1",
        modelCredits: 4,
        modelRmb: 0.35,
        quantity: 3,
        priceVersion: 2,
      }),
    ).toEqual({
      operationType: "image_generation",
      operationCredits: 8,
      operationRmb: 0.8,
      modelId: "model-1",
      modelCredits: 4,
      modelRmb: 0.35,
      quantity: 3,
      priceVersion: 2,
      totalCredits: 36,
      totalRmb: 3.45,
    });
  });

  test("matches task operations to server-managed model capabilities", () => {
    expect(modelSupportsOperation("audio_generation", ["audio"])).toBe(true);
    expect(
      modelSupportsOperation("audio_generation", ["generate", "video"]),
    ).toBe(false);
    expect(modelSupportsOperation("seamless_stitch", ["edit"])).toBe(true);
    expect(modelSupportsOperation("upscale", ["edit"])).toBe(true);
    expect(modelSupportsOperation("batch_image", ["edit"])).toBe(true);
  });
});
