import { expect, test } from "bun:test";
import { imageParameterProfile } from "../src/image-parameter-profile";
import { openAiImageParameters } from "../src/openai-image-parameters";
import { buildOpenTokenImageRequest } from "../src/opentoken-image";

test("public image options reflect provider protocol, even for identical model IDs", () => {
  expect(imageParameterProfile("openai", "gpt-image-2")).toBe("standard-flex");
  expect(imageParameterProfile("openai", "gpt-image-2.5-flare")).toBe("standard-flex-plus");
  expect(imageParameterProfile("apimart", "gpt-image-2")).toBe("gpt");
  expect(imageParameterProfile("apimart", "gemini-3.1-flash-image-preview")).toBe("gemini");
  expect(imageParameterProfile("apimart", "midjourney-blend")).toBe("midjourney-blend");
});

test("OpenAI image generations and edits forward selected quality and dimensions", () => {
  const input = { baseUrl: "https://example.test/v1", apiKey: "test-only", prompt: "test", ...openAiImageParameters({ size: "1536x1024", quality: "high" }) };
  const generated = buildOpenTokenImageRequest(input);
  expect(generated.body?.quality).toBe("high");
  expect(generated.body?.size).toBe("1536x1024");
  const edited = buildOpenTokenImageRequest({ ...input, references: [{ filename: "原稿.png", mimeType: "image/png", bytes: new Uint8Array([1]) }] });
  expect(edited.form?.get("quality")).toBe("high");
  expect(edited.form?.get("size")).toBe("1536x1024");
});

test("transparent edit output parameters survive the demo and worker parameter adapter", () => {
  expect(openAiImageParameters({ background: "transparent" }, "gpt-image-2")).toMatchObject({ background: "transparent", output_format: "png" });
  expect(() => openAiImageParameters({ background: "transparent", output_format: "jpeg" }, "gpt-image-2")).toThrow("透明背景");
  expect(openAiImageParameters({}, "gpt-image-2")).not.toHaveProperty("background");
  expect(openAiImageParameters({ background: "transparent" }, "gemini-3.1-flash-image")).toEqual({});
});

test("GPT Image 2 and 2.5 preserve documented flexible sizes and output parameters", () => {
  for (const model of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    for (const size of ["2048x2048", "2048x1152", "1152x2048", "2880x2880", "3840x2160", "2160x3840", "1536x864", "640x1024"]) {
      expect(openAiImageParameters({ size, background: "opaque", output_format: "webp", output_compression: 0 }, model))
        .toEqual({ size, quality: "auto", background: "opaque", output_format: "webp", output_compression: 0 });
    }
  }
});

test("GPT Image 2 ratios preserve their aspect without broadening legacy model sizes", () => {
  for (const modelId of ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    for (const [size, expected] of [["16:9", "1536x864"], ["9:16", "864x1536"], ["4:3", "1536x1152"], ["3:4", "1152x1536"]]) {
      expect(openAiImageParameters({ size }, modelId).size).toBe(expected);
    }
  }
  expect(openAiImageParameters({ size: "16:9" }, "gpt-image-1").size).toBe("1536x1024");
});

test("extended quality stays exclusive to the two documented 2.5 models", () => {
  for (const quality of ["xhigh", "max"] as const) {
    for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) expect(openAiImageParameters({ quality }, model).quality).toBe(quality);
    for (const model of ["gpt-image-2", "gpt-image-1", "gpt-image-2.5-unknown"]) expect(() => openAiImageParameters({ quality }, model)).toThrow("画质");
  }
});

test("invalid explicit dimensions and encoding combinations fail instead of silently changing the request", () => {
  for (const size of ["1025x1024", "4096x2048", "512x512", "3840x3840", "3072x768", "nonsense"]) {
    expect(() => openAiImageParameters({ size }, "gpt-image-2.5-flare")).toThrow("尺寸");
  }
  for (const output_compression of [-1, 101, 50.5, "bad"]) expect(() => openAiImageParameters({ output_format: "jpeg", output_compression }, "gpt-image-2")).toThrow("压缩");
  expect(() => openAiImageParameters({ output_format: "png", output_compression: 80 }, "gpt-image-2")).toThrow("压缩");
  expect(() => openAiImageParameters({ background: "white" }, "gpt-image-2")).toThrow("背景");
  expect(() => openAiImageParameters({ output_format: "gif" }, "gpt-image-2")).toThrow("格式");
});
