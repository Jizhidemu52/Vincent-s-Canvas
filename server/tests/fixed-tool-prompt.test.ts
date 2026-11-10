import { expect, test } from "bun:test";
import { MARK_IMAGE_PROVIDER_ID, MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";
import { ANGLE_CONTROL_PROMPT, DETAIL_ENHANCE_PROMPT, prepareFixedToolPrompt, SEAMLESS_PATTERN_PROMPT } from "../src/fixed-tool-prompt";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import type { PromptCompiler } from "../src/prompt-compiler";

const input = () => ({ requestId: "seamless-fixed-request", modelConfigId: "configured-mark", operationType: "seamless_stitch", toolKey: "seamless-stitch", prompt: "无缝拼接", sourceUrls: ["owned-source"], parameters: {
  size: "1:1", resolution: "2k", promptOptimization: { optimized: true, compilationId: "forged" },
  inputArchive: { ownerId: "employee-a", prompt: "无缝拼接", effectivePrompt: "client authored instruction", references: [{ url: "owned-source" }], config: { count: "1", systemPrompt: "client system" } },
} });
const mark = { providerId: MARK_IMAGE_PROVIDER_ID, protocol: "apimart", modelId: "gpt-image-2.5-flare" };

test.each(MARK_PLATFORM_MODELS.filter(model => (model.capabilities as readonly string[]).includes("edit")))("$modelId uses one trusted server template and preserves references, ownership and parameters", model => {
  const original = input();
  const prepared = prepareFixedToolPrompt(original, { ...mark, modelId: model.modelId });
  expect(prepared.prompt).toBe(SEAMLESS_PATTERN_PROMPT);
  expect(prepared.parameters).toMatchObject({ size: "1:1", resolution: "2k", inputArchive: { ownerId: "employee-a", prompt: "无缝拼接", effectivePrompt: SEAMLESS_PATTERN_PROMPT, references: original.parameters.inputArchive.references, config: { count: "1", systemPrompt: "" } } });
  expect(prepared.parameters.promptOptimization).toBeUndefined();
  expect(prepared.sourceUrls).toEqual(original.sourceUrls);
  expect(original.parameters.inputArchive.effectivePrompt).toBe("client authored instruction");
  expect(original.parameters.promptOptimization.compilationId).toBe("forged");
});

test("fixed tool task preparation never resolves targets, sources, recipes or an LLM", async () => {
  const compiler = new Proxy({}, { get() { throw new Error("Fixed template must not call the compiler"); } }) as PromptCompiler;
  const prepared = await preparePromptTaskInput(compiler, { id: "employee-a", role: "designer" }, input(), { fixedToolTarget: mark });
  expect(prepared).toMatchObject({ prompt: SEAMLESS_PATTERN_PROMPT, optimized: false });
  expect(prepared.promptCompilationId).toBeUndefined();
  expect(prepared.userInput).toBeUndefined();
});

test("legacy workflow and unrelated tools retain their exact prompt and knob parameters", () => {
  const legacy = { ...input(), parameters: { cutWidth: 200, redrawWidth: 200, blurAmount: 100, redrawStrength: 1, steps: 12 } };
  for (const target of [undefined, { ...mark, protocol: "custom", modelId: "sflxjj" }, { ...mark, providerId: "another-provider" }, { ...mark, modelId: "other-workflow" }]) {
    expect(prepareFixedToolPrompt(legacy, target)).toBe(legacy);
  }
  const other = { ...input(), toolKey: "image-edit", operationType: "inpaint" };
  expect(prepareFixedToolPrompt(other, mark)).toBe(other);
});

test.each([
  ["detail-enhance", "upscale", DETAIL_ENHANCE_PROMPT],
  ["angle-control", "inpaint", ANGLE_CONTROL_PROMPT],
])("%s adds only the fixed task contract and retains the user's exact text without an LLM", async (toolKey, operationType, instruction) => {
  const userPrompt = "  图片1是原图，图片2仅参考质感。\n45° 视角；保持7粒扣与‘A&B 2026’原字样，不改#A1b2C3。  ";
  const original = { ...input(), toolKey, operationType, prompt: userPrompt };
  for (const protocol of ["openai", "apimart"]) {
    const compiler = new Proxy({}, { get() { throw new Error("Fixed template must not call the compiler"); } }) as PromptCompiler;
    const prepared = await preparePromptTaskInput(compiler, { id: "employee-a", role: "designer" }, original, { fixedToolTarget: { ...mark, protocol } });
    expect(prepared).toMatchObject({ optimized: false, prompt: `${instruction}\n\n用户要求：\n${userPrompt}`, parameters: { size: "1:1", resolution: "2k" } });
    expect(prepared.promptCompilationId).toBeUndefined();
    expect(prepared.parameters.inputArchive.effectivePrompt).toBe(prepared.prompt);
    expect(prepared.parameters.inputArchive.references).toEqual(original.parameters.inputArchive.references);
    expect(prepared.parameters.inputArchive.ownerId).toBe("employee-a");
    expect(prepared.parameters.inputArchive.config.systemPrompt).toBe(original.parameters.inputArchive.config.systemPrompt);
    expect(original.prompt).toBe(userPrompt);
    expect(prepareFixedToolPrompt(prepared, { ...mark, protocol }).prompt).toBe(prepared.prompt);
  }
});

test.each([
  ["detail-enhance", "upscale"],
  ["angle-control", "inpaint"],
])("%s leaves custom workflows, quick actions and mismatched operations unchanged", (toolKey, operationType) => {
  const original = { ...input(), toolKey, operationType, prompt: '{"workflow_angle":45,"text":"原文"}' };
  for (const target of [undefined, { ...mark, protocol: "custom" }, { ...mark, workflowConfigId: "existing-workflow" }, { ...mark, protocol: "anthropic" }]) {
    expect(prepareFixedToolPrompt(original, target)).toBe(original);
  }
  const quick = { ...original, parameters: { ...original.parameters, quickImageAction: "hd-upscale" } };
  expect(prepareFixedToolPrompt(quick, mark)).toBe(quick);
  const mismatch = { ...original, operationType: "image_generation" };
  expect(prepareFixedToolPrompt(mismatch, mark)).toBe(mismatch);
});
