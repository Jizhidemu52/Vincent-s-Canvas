import { expect, test } from "bun:test";
import { publicPromptTaskPreview } from "../src/prompt-task-preview";
import { applyImagePromptExclusions } from "../src/image-prompt-exclusions";
const input = { prompt: "只改衣身蓝色。", promptInput: { scene: "garment-colorway" as const, fields: {}, userText: "衣身蓝色", mode: "edit" as const, referenceRoles: [], hasMask: false, compilationId: "compilation" },
  summaryZh: "只改衣身颜色", optimized: false, operationType: "inpaint", parameters: { negative_prompt: "条纹", secretFixture: "must-not-leak" } };
test("preview exposes the actual post-exclusion prompt without authoring or provider data", () => {
  const prepared = applyImagePromptExclusions(input, { modelId: "gpt-image-2.6-sunburst", protocol: "apimart" });
  const preview = publicPromptTaskPreview(prepared);
  expect(preview.prompt).toBe(prepared.prompt); expect(preview.prompt).toContain("排除要求");
  expect(preview.promptInput.compilationId).toBe("compilation"); expect(JSON.stringify(preview)).not.toContain("secretFixture");
  expect(preview).not.toHaveProperty("nativeNegativePrompt");
});
test("native exclusions remain separate from the main text", () => {
  const prepared = applyImagePromptExclusions(input, { modelId: "midjourney", protocol: "apimart" });
  expect(publicPromptTaskPreview(prepared)).toMatchObject({ prompt: input.prompt, nativeNegativePrompt: "条纹" });
});
test("raw or uncompiled output cannot masquerade as a bound preview", () => {
  expect(() => publicPromptTaskPreview({ prompt: "raw", parameters: {} })).toThrow("已编译");
});
