import { describe, expect, spyOn, test } from "bun:test";

import {
  buildOpenTokenImageRequest,
  isOpenTokenImageModel,
  openTokenErrorMessage,
  parseOpenTokenImageResponse,
  runOpenTokenImage,
} from "../src/opentoken-image";
import type { GenerationTiming, GenerationTimingStage } from "../src/generation-timing";
import { openAiImageParameters } from "../src/openai-image-parameters";

function recordTiming(events: string[]): GenerationTiming {
  return {
    async measure<T>(stage: GenerationTimingStage, action: () => Promise<T> | T): Promise<T> {
      events.push(`${stage}:start`);
      try {
        const result = await action();
        events.push(`${stage}:success`);
        return result;
      } catch (error) {
        events.push(`${stage}:failed`);
        throw error;
      }
    },
    finish(outcome) { events.push(`finish:${outcome}`); },
  };
}

describe("OpenToken image protocol adapter", () => {
  test("all documented image fields reach both endpoints and a mask is a separate file", async () => {
    const reference = { filename: "source.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const mask = { filename: "mask.png", mimeType: "image/png", bytes: new Uint8Array([4, 5, 6]) };
    const input = { baseUrl: "https://example.test/v1", apiKey: "test", modelId: "gpt-image-2.5-flare" as const, prompt: "edit", size: "3840x2160", quality: "max" as const, background: "transparent" as const, output_format: "webp" as const, output_compression: 90 };
    expect(buildOpenTokenImageRequest(input).body).toEqual({ model: input.modelId, prompt: "edit", n: 1, size: "3840x2160", quality: "max", background: "transparent", output_format: "webp", output_compression: 90 });
    const edit = buildOpenTokenImageRequest({ ...input, references: [reference], mask });
    expect(edit.form?.getAll("image")).toHaveLength(1);
    expect(edit.form?.get("quality")).toBe("max");
    expect(edit.form?.get("output_format")).toBe("webp");
    expect(edit.form?.get("output_compression")).toBe("90");
    expect(Array.from(new Uint8Array(await (edit.form?.get("mask") as File).arrayBuffer()))).toEqual([4, 5, 6]);
    expect(() => buildOpenTokenImageRequest({ ...input, mask })).toThrow("原图");
    expect(() => buildOpenTokenImageRequest({ ...input, modelId: "gemini-3.1-flash-image", references: [reference], mask })).toThrow("蒙版");
  });

  test("inline JPEG and WebP responses keep the selected MIME type", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ data: [{ b64_json: "AP8BAg==" }] })) as unknown as typeof fetch;
    try {
      for (const output_format of ["jpeg", "webp"] as const) expect(await runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test", prompt: "test", output_format })).toBe(`data:image/${output_format};base64,AP8BAg==`);
    } finally { globalThis.fetch = originalFetch; }
  });
  for (const modelId of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const) {
    for (const quality of ["low", "medium", "high", "auto", ...(modelId === "gpt-image-2" ? [] : ["xhigh", "max"] as const)] as const) {
      test(`${modelId} forwards ${quality} unchanged through generation and edit parameters`, async () => {
        const input = {
          baseUrl: "https://example.test/v1", apiKey: "test-only", modelId, prompt: "quality fixture",
          ...openAiImageParameters({ quality, size: "1024x1024", resolution: "4k" }, modelId),
        };
        const generation = buildOpenTokenImageRequest(input);
        expect(generation.url).toBe("https://example.test/v1/images/generations");
        expect(generation.body).toEqual({ model: modelId, prompt: "quality fixture", n: 1, size: "1024x1024", quality });
        const source = new Uint8Array([0, 255, 1, 2]);
        const edit = buildOpenTokenImageRequest({ ...input, references: [{ filename: "source.png", mimeType: "image/png", bytes: source }] });
        expect(edit.url).toBe("https://example.test/v1/images/edits");
        expect(edit.method).toBe(generation.method);
        expect(edit.form?.get("quality")).toBe(quality);
        expect(edit.form?.get("size")).toBe("1024x1024");
        expect(edit.form?.get("model")).toBe(modelId);
        expect(new Uint8Array(await (edit.form?.get("image") as Blob).arrayBuffer())).toEqual(source);
      });
    }
  }

  test("times response headers, JSON and complete result bytes separately without changing the image", async () => {
    const events: string[] = [];
    const provider = Response.json({ data: [{ url: "https://image.test/result.webp" }] });
    const readJson = provider.json.bind(provider);
    provider.json = async () => { events.push("read_json"); return readJson(); };
    const image = new Response(new Uint8Array([0, 255, 1, 2]), { headers: { "content-type": "image/webp; charset=binary" } });
    const readBytes = image.arrayBuffer.bind(image);
    image.arrayBuffer = async () => { events.push("read_image_body"); return readBytes(); };
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: string | URL | Request) => {
      if (String(url) === "http://opentoken.test/v1/images/generations") { events.push("submit"); return provider; }
      if (String(url) === "https://image.test/result.webp") { events.push("download"); return image; }
      throw new Error("Unexpected network request");
    }, { preconnect() {} }));
    try {
      const result = await runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test", quality: "high" }, recordTiming(events));
      expect(result).toBe("data:image/webp;base64,AP8BAg==");
      expect(events).toEqual([
        "prepare:start", "prepare:success",
        "provider_request:start", "submit", "provider_request:success",
        "provider_response:start", "read_json", "provider_response:success",
        "result_download:start", "download", "read_image_body", "result_download:success",
      ]);
    } finally { fetchMock.mockRestore(); }
  });

  test("inline base64 results do not report a download that never happened", async () => {
    const events: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ data: [{ b64_json: "AP8BAg==" }] }), { preconnect() {} }));
    try {
      expect(await runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test" }, recordTiming(events))).toBe("data:image/png;base64,AP8BAg==");
      expect(events).toEqual([
        "prepare:start", "prepare:success",
        "provider_request:start", "provider_request:success",
        "provider_response:start", "provider_response:success",
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { fetchMock.mockRestore(); }
  });

  test("a data URL in the provider URL field is not classified as a network download", async () => {
    const events: string[] = [];
    const nativeFetch = globalThis.fetch;
    const inline = "data:image/png;base64,AP8BAg==";
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "http://opentoken.test/v1/images/generations") return Response.json({ data: [{ url: inline }] });
      if (String(url) === inline) return nativeFetch(url, init);
      throw new Error("Unexpected remote download");
    }, { preconnect() {} }));
    try {
      expect(await runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test" }, recordTiming(events))).toBe(inline);
      expect(events).toEqual(["prepare:start", "prepare:success", "provider_request:start", "provider_request:success", "provider_response:start", "provider_response:success"]);
    } finally { fetchMock.mockRestore(); }
  });

  for (const failedStage of ["provider_response", "result_download"] as const) {
    test(`a ${failedStage} body failure is timed and preserves the error without resubmitting`, async () => {
      const events: string[] = [];
      const failure = new Error("response body interrupted");
      let submissions = 0;
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: string | URL | Request) => {
        if (String(url) === "http://opentoken.test/v1/images/generations") {
          submissions++;
          const provider = Response.json({ data: [{ url: "https://image.test/result.png" }] });
          if (failedStage === "provider_response") provider.json = async () => { throw failure; };
          return provider;
        }
        if (String(url) === "https://image.test/result.png") {
          const image = new Response(new Uint8Array([1]));
          image.arrayBuffer = async () => { throw failure; };
          return image;
        }
        throw new Error("Unexpected network request");
      }, { preconnect() {} }));
      try {
        const error = await runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test" }, recordTiming(events)).catch(error => error);
        expect(error).toBe(failure);
        expect(events.at(-1)).toBe(`${failedStage}:failed`);
        expect(submissions).toBe(1);
      } finally { fetchMock.mockRestore(); }
    });
  }

  for (const validJson of [true, false]) {
    test(`provider HTTP errors time the ${validJson ? "JSON" : "invalid JSON"} response without swallowing its status`, async () => {
      const events: string[] = [];
      const provider = validJson ? Response.json({ error: { message: "quota exceeded" } }, { status: 429 }) : new Response("upstream unavailable", { status: 503 });
      const readJson = provider.json.bind(provider);
      provider.json = async () => { events.push("read_error_json"); return readJson(); };
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => provider, { preconnect() {} }));
      try {
        await expect(runOpenTokenImage({ baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test" }, recordTiming(events))).rejects.toThrow(validJson ? "OpenToken image request failed: 429: quota exceeded" : "OpenToken image request failed: 503");
        expect(events).toEqual([
          "prepare:start", "prepare:success",
          "provider_request:start", "provider_request:success",
          "provider_response:start", "read_error_json", "provider_response:failed",
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally { fetchMock.mockRestore(); }
    });
  }

  test("distinguishes submission and result-download transport failures without resubmitting", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const input = { baseUrl: "http://opentoken.test/v1", apiKey: "test-key", prompt: "test" };
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
        quality: "auto",
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
    expect(request.form?.get("quality")).toBe("auto");
    expect(request.form?.getAll("image")).toHaveLength(1);
  });

  test("reads either a provider URL or inline base64 image result", () => {
    expect(parseOpenTokenImageResponse({ data: [{ url: "https://images.example.test/result.png" }] })).toEqual({ url: "https://images.example.test/result.png" });
    expect(parseOpenTokenImageResponse({ data: [{ b64_json: "aGVsbG8=" }] })).toEqual({ base64: "aGVsbG8=" });
  });

  test("maps legacy canvas ratios without changing the requested composition", () => {
    expect(buildOpenTokenImageRequest({ baseUrl: "https://cn2.gw.opentoken.io/v1", apiKey: "test-key", prompt: "landscape", size: "16:9" }).body?.size).toBe("1536x864");
    expect(buildOpenTokenImageRequest({ baseUrl: "https://cn2.gw.opentoken.io/v1", apiKey: "test-key", prompt: "portrait", size: "9:16" }).body?.size).toBe("864x1536");
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
