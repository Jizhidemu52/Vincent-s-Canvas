import { describe, expect, test } from "bun:test";

import { apiMartImageModel, buildApiMartImageRequest } from "../src/apimart-image";

describe("APIMart image protocol adapter", () => {
  test("recognizes the configured image model aliases", () => {
    expect(apiMartImageModel("gpt-image-2-ext")).toBe("gpt-image-2");
    expect(apiMartImageModel("nano-banana-2")).toBe("gemini-3.1-flash-image-preview");
    expect(apiMartImageModel("midjourney-v7")).toBe("midjourney");
  });

  test("builds GPT-Image-2 generation with supported limits", () => {
    const request = buildApiMartImageRequest({
      modelId: "gpt-image-2",
      prompt: "A studio product photograph",
      parameters: { count: 20, size: "16:9", resolution: "4k" },
      sourceDataUrls: ["data:image/png;base64,AA=="],
    });
    expect(request.path).toBe("/images/generations");
    expect(request.payload).toMatchObject({ model: "gpt-image-2", n: 10, size: "16:9", resolution: "4k" });
  });

  test("builds Gemini Flash with one output and its own options", () => {
    const request = buildApiMartImageRequest({
      modelId: "gemini-3.1-flash-image-preview",
      prompt: "A seamless floral print",
      parameters: { count: 5, size: "1:1", resolution: "2k", googleImageSearch: true },
    });
    expect(request.payload).toMatchObject({
      model: "gemini-3.1-flash-image-preview",
      n: 5,
      size: "1:1",
      resolution: "2K",
      google_search: true,
      google_image_search: true,
    });
  });

  test("builds the Midjourney route and appends aspect ratio", () => {
    const request = buildApiMartImageRequest({
      modelId: "midjourney",
      prompt: "editorial fashion illustration",
      parameters: { size: "16:9" },
    });
    expect(request.path).toBe("/midjourney/generations");
    expect(request.payload).toEqual({
      prompt: "editorial fashion illustration --ar 16:9",
      size: "16:9",
      version: "6.1",
      speed: "relax",
    });
  });

  test("builds a Midjourney Blend task from two to four images", () => {
    const request = buildApiMartImageRequest({
      modelId: "midjourney-blend",
      prompt: "ignored",
      parameters: { size: "3:2", midjourneySpeed: "turbo" },
      sourceDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="],
    });
    expect(request.path).toBe("/midjourney/generations/blend");
    expect(request.payload).toMatchObject({ size: "3:2", speed: "turbo" });
  });

  test("rejects Midjourney reference images before submitting", () => {
    expect(() => buildApiMartImageRequest({
      modelId: "midjourney",
      prompt: "fashion campaign",
      parameters: {},
      sourceDataUrls: ["data:image/png;base64,AA=="],
    })).toThrow("Midjourney");
  });
});
