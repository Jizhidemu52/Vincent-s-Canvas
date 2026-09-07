import { describe, expect, test } from "bun:test";

import {
  buildOpenTokenImageRequest,
  openTokenErrorMessage,
  parseOpenTokenImageResponse,
} from "../src/opentoken-image";

describe("OpenToken image protocol adapter", () => {
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
