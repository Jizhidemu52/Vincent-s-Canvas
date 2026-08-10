import { describe, expect, test } from "bun:test";

import {
  buildOpenTokenImageRequest,
  parseOpenTokenImageResponse,
} from "../src/opentoken-image";

describe("OpenToken image protocol adapter", () => {
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
        size: "1:1",
        resolution: "1k",
      },
    });
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
    expect(request.form?.get("size")).toBe("1:1");
    expect(request.form?.get("resolution")).toBe("1k");
    expect(request.form?.getAll("image")).toHaveLength(1);
  });

  test("reads either a provider URL or inline base64 image result", () => {
    expect(parseOpenTokenImageResponse({ data: [{ url: "https://images.example.test/result.png" }] })).toEqual({ url: "https://images.example.test/result.png" });
    expect(parseOpenTokenImageResponse({ data: [{ b64_json: "aGVsbG8=" }] })).toEqual({ base64: "aGVsbG8=" });
  });

  test("rejects a successful response without an image", () => {
    expect(() => parseOpenTokenImageResponse({ data: [] })).toThrow("OpenToken did not return an image");
  });
});
