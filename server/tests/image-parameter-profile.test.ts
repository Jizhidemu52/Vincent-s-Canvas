import { expect, test } from "bun:test";
import { imageParameterProfile } from "../src/image-parameter-profile";
import { openAiImageParameters } from "../src/openai-image-parameters";
import { buildOpenTokenImageRequest } from "../src/opentoken-image";

test("public image options reflect provider protocol, even for identical model IDs", () => {
  expect(imageParameterProfile("openai", "gpt-image-2")).toBe("standard");
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
  expect(openAiImageParameters({ background: "transparent", output_format: "jpeg" }, "gpt-image-2")).toMatchObject({ background: "transparent", output_format: "png" });
  expect(openAiImageParameters({}, "gpt-image-2")).not.toHaveProperty("background");
  expect(openAiImageParameters({ background: "transparent" }, "gemini-3.1-flash-image")).toEqual({});
});
