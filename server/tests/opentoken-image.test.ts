import { describe, expect, spyOn, test } from "bun:test";

import {
  buildOpenTokenImageRequest,
  isOpenTokenImageModel,
  openTokenErrorMessage,
  parseOpenTokenImageResponse,
  runOpenTokenImage,
} from "../src/opentoken-image";

describe("OpenToken image protocol adapter", () => {
  test("distinguishes submission and result-download transport failures without resubmitting", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const input = { baseUrl: "https://opentoken.test/v1", apiKey: "test-key", prompt: "test" };
    let calls = 0;
    try {
      fetchMock.mockImplementation(Object.assign(async () => { calls += 1; throw new Error("unknown certificate verification error"); }, { preconnect() {} }));
      await expect(runOpenTokenImage(input)).rejects.toThrow("OpenToken image submission transport failed: unknown certificate verification error");
      expect(calls).toBe(1);
      calls = 0;
      fetchMock.mockImplementation(Object.assign(async () => {
        calls += 1;
        if (calls === 1) return Response.json({ data: [{ url: "https://image.test/result.png" }] });
        throw new Error("unknown certificate verification error");
      }, { preconnect() {} }));
      await expect(runOpenTokenImage(input)).rejects.toThrow("OpenToken image result download transport failed: unknown certificate verification error");
      expect(calls).toBe(2);
    } finally { fetchMock.mockRestore(); }
  });

  test("accepts both GPT Image 2.5 image models without admitting chat or unknown models", () => {
    expect(isOpenTokenImageModel("gpt-image-2.5-flare")).toBe(true);
    expect(isOpenTokenImageModel("gpt-image-2.5-sunburst")).toBe(true);
    expect(isOpenTokenImageModel("gpt-image-2")).toBe(true);
    expect(isOpenTokenImageModel("gemini-3.1-flash-image")).toBe(true);
    expect(isOpenTokenImageModel("gpt-5.5")).toBe(false);
    expect(isOpenTokenImageModel("gpt-image-2.5-unknown")).toBe(false);
    expect(isOpenTokenImageModel(undefined)).toBe(false);
  });

  for (const modelId of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const) {
    test(`${modelId} is preserved in generation and reference-image edit requests`, () => {
      const input = { baseUrl: "https://example.test/v1", apiKey: "shared-test-key", modelId, prompt: "A green vase", size: "auto", quality: "auto" as const };
      const generation = buildOpenTokenImageRequest(input);
      expect(generation.url).toBe("https://example.test/v1/images/generations");
      expect(generation.body).toMatchObject({ model: modelId, n: 1, size: "auto", quality: "auto" });
      expect(generation.headers.authorization).toBe("Bearer shared-test-key");
      const edit = buildOpenTokenImageRequest({ ...input, references: [{ filename: "source.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }] });
      expect(edit.url).toBe("https://example.test/v1/images/edits");
      expect(edit.form?.get("model")).toBe(modelId);
      expect(edit.form?.getAll("image")).toHaveLength(1);
      expect(edit.headers.authorization).toBe(generation.headers.authorization);
    });
  }

  test("native transparent edits preserve source bytes and send PNG output parameters", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 255]);
    const request = buildOpenTokenImageRequest({ baseUrl: "https://example.test/v1", apiKey: "test", prompt: "衣领改紫色", background: "transparent", references: [{ filename: "原图.png", mimeType: "image/png", bytes }] });
    expect(request.form?.get("background")).toBe("transparent");
    expect(request.form?.get("output_format")).toBe("png");
    expect(new Uint8Array(await (request.form?.get("image") as Blob).arrayBuffer())).toEqual(bytes);
    expect(request.form?.get("prompt")).toBe("衣领改紫色");
  });
  test("builds an OpenAI-compatible GPT-Image-2 generation request", () => {
    expect(
      buildOpenTokenImageRequest({
        baseUrl: "https://cn2.gw.opentoken.io/v1/",
        apiKey: "test-key",
        prompt: "A blue ceramic button on a white background",
        size: "1:1",
        resolution: "1k",
      }),
    ).toMatchObject({
      url: "https://cn2.gw.opentoken.io/v1/images/generations",
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: {
        model: "gpt-image-2",
        prompt: "A blue ceramic button on a white background",
        n: 1,
        size: "1024x1024",
        quality: "low",
      },
    });
  });

  test("preserves the selected OpenToken image model in a generation request", () => {
    const request = buildOpenTokenImageRequest({
      baseUrl: "https://cn2.gw.opentoken.io/v1",
      apiKey: "test-key",
      modelId: "gemini-3.1-flash-image",
      prompt: "A fashion sketch on a white background",
    });

    expect(request.body?.model).toBe("gemini-3.1-flash-image");
    expect(request.body).not.toHaveProperty("size");
    expect(request.body).not.toHaveProperty("quality");
  });

  test("uses the image edits endpoint when reference images are supplied", () => {
    const request = buildOpenTokenImageRequest({
      baseUrl: "https://cn2.gw.opentoken.io/v1",
      apiKey: "test-key",
      prompt: "Replace the background with light gray",
      size: "1:1",
      resolution: "1k",
      references: [{ filename: "source.png", mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }],
    });

    expect(request.url).toBe("https://cn2.gw.opentoken.io/v1/images/edits");
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(request.form?.get("model")).toBe("gpt-image-2");
    expect(request.form?.get("prompt")).toBe("Replace the background with light gray");
    expect(request.form?.get("size")).toBe("1024x1024");
    expect(request.form?.get("quality")).toBe("low");
    expect(request.form?.getAll("image")).toHaveLength(1);
  });

  test("reads either a provider URL or inline base64 image result", () => {
    expect(parseOpenTokenImageResponse({ data: [{ url: "https://images.example.test/result.png" }] })).toEqual({ url: "https://images.example.test/result.png" });
    expect(parseOpenTokenImageResponse({ data: [{ b64_json: "aGVsbG8=" }] })).toEqual({ base64: "aGVsbG8=" });
  });

  test("maps canvas ratios to OpenToken's exact supported size values", () => {
    expect(buildOpenTokenImageRequest({ baseUrl: "https://cn2.gw.opentoken.io/v1", apiKey: "test-key", prompt: "landscape", size: "16:9" }).body?.size).toBe("1536x1024");
    expect(buildOpenTokenImageRequest({ baseUrl: "https://cn2.gw.opentoken.io/v1", apiKey: "test-key", prompt: "portrait", size: "9:16" }).body?.size).toBe("1024x1536");
    expect(buildOpenTokenImageRequest({ baseUrl: "https://cn2.gw.opentoken.io/v1", apiKey: "test-key", prompt: "adaptive", size: "auto" }).body?.size).toBe("auto");
  });

  test("rejects a successful response without an image", () => {
    expect(() => parseOpenTokenImageResponse({ data: [] })).toThrow("OpenToken did not return an image");
  });

  test("keeps a provider quota message visible to the designer", () => {
    expect(
      openTokenErrorMessage({
        error: { message: "Key 今日额度已用尽，请等待次日重置" },
      }),
    ).toBe("Key 今日额度已用尽，请等待次日重置");
  });
});
