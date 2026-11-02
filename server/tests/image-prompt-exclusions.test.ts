import { expect, test } from "bun:test";
import { applyImagePromptExclusions } from "../src/image-prompt-exclusions";
import { buildApiMartImageRequest } from "../src/apimart-image";

const input = () => ({ operationType: "image_generation", prompt: "一件蓝色衬衫", parameters: { negative_prompt: "  水印、额外文字  ", inputArchive: { prompt: "原始草稿", effectivePrompt: "一件蓝色衬衫", config: { imageOptions: '{"negative_prompt":"水印、额外文字"}' } } } as Record<string, unknown> });

test("unsupported native negative fields become server prompt constraints without mutating authoring or archive", () => {
  const original = input();
  const prepared = applyImagePromptExclusions(original, { modelId: "gemini-3.1-flash-image-preview", protocol: "apimart" });
  expect(prepared.prompt).toBe("一件蓝色衬衫\n\n排除要求（自然语言约束）：请不要在生成结果中出现以下内容：\n水印、额外文字");
  expect(prepared.parameters.negative_prompt).toBeUndefined();
  expect(prepared.parameters.promptExclusions).toEqual({ sourcePrompt: original.prompt, negativePrompt: "水印、额外文字", submittedPrompt: prepared.prompt, mode: "prompt" });
  expect(prepared.parameters.inputArchive).toMatchObject({ prompt: "原始草稿", effectivePrompt: original.prompt, submittedPrompt: prepared.prompt });
  expect(original.prompt).toBe("一件蓝色衬衫"); expect(original.parameters).not.toHaveProperty("promptExclusions");
  expect(buildApiMartImageRequest({ modelId: "gemini-3.1-flash-image-preview", prompt: prepared.prompt, parameters: prepared.parameters }).payload).toMatchObject({ prompt: prepared.prompt });
  expect(buildApiMartImageRequest({ modelId: "gemini-3.1-flash-image-preview", prompt: prepared.prompt, parameters: prepared.parameters }).payload).not.toHaveProperty("negative_prompt");
});

test("verified Midjourney uses its native exclusion exactly once and replay starts from the original prompt", () => {
  for (const modelId of ["midjourney", "midjourney-v7"]) {
    const prepared = applyImagePromptExclusions(input(), { modelId, protocol: "apimart" });
    expect(prepared.prompt).toBe(input().prompt);
    const request = buildApiMartImageRequest({ modelId, prompt: prepared.prompt, parameters: prepared.parameters });
    expect(request.payload.prompt).toBe(input().prompt); expect(request.payload.negative_prompt).toBe("水印、额外文字");
    expect(prepared.parameters.promptExclusions).toMatchObject({ mode: "native" });
  }
  const once = applyImagePromptExclusions(input(), { modelId: "gpt-image-2", protocol: "openai" });
  const replay = applyImagePromptExclusions(input(), { modelId: "gpt-image-2", protocol: "openai" });
  expect(replay.prompt).toBe(once.prompt); expect(replay.prompt.match(/排除要求/g)).toHaveLength(1);
});

test("empty, forged, invalid and no-prompt inputs are handled before admission", () => {
  const base = input();
  expect(applyImagePromptExclusions({ ...base, parameters: { negative_prompt: " ", promptExclusions: { sourcePrompt: "forged" } } }).parameters).toEqual({});
  expect(() => applyImagePromptExclusions({ ...base, parameters: { negative_prompt: 4 } })).toThrow("必须为文字");
  expect(() => applyImagePromptExclusions({ ...base, parameters: { negative_prompt: "x".repeat(4001) } })).toThrow("4000");
  expect(() => applyImagePromptExclusions({ ...base, prompt: "x".repeat(19999) })).toThrow("20000");
  expect(() => applyImagePromptExclusions(base, { modelId: "midjourney-blend", protocol: "apimart" })).toThrow("多图融合");
  const video = { ...base, operationType: "video_generation" };
  expect(applyImagePromptExclusions(video)).toBe(video);
});
