import { afterEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { PromptCompiler, type PromptOptimizer } from "../src/prompt-compiler";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import { publicPromptTaskPreview } from "../src/prompt-task-preview";
import { ChatProtocolError } from "../src/routes/chat";
import type { PromptFallbackPolicy } from "../src/prompt-original-fallback";

const actor = { id: "employee-test", role: "designer" };
const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach(close => close()));
const policy: PromptFallbackPolicy = { PROMPT_OPTIMIZATION_TIMEOUT_MS: 25, PROMPT_OPTIMIZATION_FALLBACK: "original", PROMPT_FALLBACK_TOOL_KEYS: "creative-*" };
const form = () => ({ requestId: randomUUID(), toolKey: "creative-text-to-style", modelConfigId: "image", prompt: "蓝色衬衫", operationType: "image_generation", sourceUrls: [], parameters: {},
  promptInput: { scene: "text-to-style" as const, userText: "蓝色衬衫", fields: {}, referenceRoles: [], mode: "generate" as const, hasMask: false } });
async function fixture(invoke: PromptOptimizer["invoke"], options = policy) {
  const db = sqlitePromptRecipeStore(":memory:");
  closers.push(db.close);
  const key = "text-to-style";
  await db.store.ensure(key, { name: key, enabled: true, modelConfigId: "optimizer", failurePolicy: "stop" });
  const version = await db.store.saveVersion(key, { systemPrompt: "Output a visual description.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "fixture" }, "admin");
  await db.store.activate(key, version.id);
  const calls = mock(invoke);
  const compiler = new PromptCompiler(db.store, {
    resolveTarget: async () => ({ id: "image", modelId: "image", protocol: "apimart", fingerprint: "image" }),
    resolveOptimizer: async () => ({ id: "optimizer", modelId: "optimizer", fingerprint: "optimizer", estimatedRmbCost: null, invoke: calls }),
    readSource: async () => { throw new Error("unexpected reference"); },
  }, options);
  return { compiler, calls, prepare: (input: Parameters<typeof preparePromptTaskInput>[2]) => preparePromptTaskInput(compiler, actor, input) };
}
const unavailable = async () => { throw new ChatProtocolError("UPSTREAM_REQUEST_FAILED", "provider unavailable", 500); };

test("超时可用原文，预览与后续提交复用失败记录，不重复调用优化模型", async () => {
  let aborted = false;
  const f = await fixture((_s, _c, context) => new Promise((_resolve, reject) => context.signal?.addEventListener("abort", () => { aborted = true; reject(context.signal?.reason); }, { once: true })));
  const input = form();
  const first = await f.prepare(input);
  expect(aborted).toBe(true);
  expect(first).toMatchObject({ prompt: input.prompt, optimized: false, parameters: { promptOptimization: { fallback: true, code: "PROMPT_OPTIMIZATION_TIMEOUT" } } });
  const preview = publicPromptTaskPreview(first);
  const admitted = await f.prepare({ ...input, promptInput: preview.promptInput });
  expect(admitted.prompt).toBe(preview.prompt);
  expect(admitted.promptCompilationId).toBeUndefined();
  expect(admitted.userInput?.compilationId).toBeUndefined();
  expect(f.calls).toHaveBeenCalledTimes(1);
});
test("模型传输失败保留结构化要求，不把失败记作优化成功", async () => {
  const f = await fixture(unavailable);
  const input = form();
  input.promptInput.fields = { keepDetails: "保留五粒纽扣" };
  const result = await f.prepare(input);
  expect(result.prompt).toContain("蓝色衬衫"); expect(result.prompt).toContain("保留五粒纽扣");
  expect(result.optimized).toBe(false);
  expect((await f.compiler.store.byRequest(actor.id, input.requestId))?.status).toBe("failed");
});
test("空原文、未授权工具、关闭开关均不降级", async () => {
  const a = await fixture(unavailable);
  const input = form(); input.prompt = ""; input.promptInput.userText = "";
  await expect(a.prepare(input)).rejects.toThrow();
  for (const flags of [{ ...policy, PROMPT_FALLBACK_TOOL_KEYS: "" }, { ...policy, PROMPT_OPTIMIZATION_FALLBACK: "off" as const }]) {
    const f = await fixture(unavailable, flags);
    await expect(f.prepare(form())).rejects.toThrow();
  }
});
test("字段错误和无权引用不会被降级", async () => {
  const f = await fixture(unavailable);
  const input = form(); input.promptInput.fields = { keepDetails: [] };
  await expect(f.prepare(input)).rejects.toMatchObject({ code: "PROMPT_FIELDS_INVALID" });
  await expect(f.prepare({ ...form(), promptInput: { ...form().promptInput, compilationId: randomUUID() } })).rejects.toMatchObject({ code: "PROMPT_COMPILATION_NOT_FOUND" });
  expect(f.calls).not.toHaveBeenCalled();
});
