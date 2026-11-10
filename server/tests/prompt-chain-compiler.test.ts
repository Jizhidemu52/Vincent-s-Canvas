import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PromptCompilationRequest, PromptRecipeVersionContent, PromptScene } from "../../shared/prompt-contracts";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { PromptCompiler, type PromptCompilerRuntime, type PromptOptimizer } from "../src/prompt-compiler";
import { preparePromptTaskInput } from "../src/prompt-task-input";
import { publicPromptCompilation } from "../src/prompt-recipe-store";
import { assertMinimalPromptFidelity, promptOutputMetrics } from "../src/prompt-minimal-policy";

const close: Array<() => void> = [];
afterEach(() => close.splice(0).forEach(dispose => dispose()));
const actor = { id: "chain-employee", role: "designer" };
const version = (strategy: PromptRecipeVersionContent["executionStrategy"] = "template-first"): PromptRecipeVersionContent => ({
  executionStrategy: strategy, systemPrompt: "Only describe the requested visual changes.", fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "", outputLanguage: "zh", changeNote: "isolated fixture",
});
const request = (scene: PromptScene = "garment-colorway", fields: Record<string, unknown> = { colorMode: "specific", colors: ["#789282"], colorRegion: "衣身" }): PromptCompilationRequest => ({
  requestId: randomUUID(), modelConfigId: "image-model", sourceUrls: ["original"], toolKey: `creative-${scene}`,
  promptInput: { scene, fields, userText: "保留8颗纽扣及文字“NOVA 73”", mode: "edit", referenceRoles: ["服装原图"], hasMask: false },
});
async function fixture(scene: PromptScene = "garment-colorway", strategy: PromptRecipeVersionContent["executionStrategy"] = "template-first", result?: string) {
  const db = sqlitePromptRecipeStore(":memory:"); close.push(db.close);
  await db.store.ensure(scene, { name: scene, enabled: true, modelConfigId: result ? "planner" : null, failurePolicy: "stop" });
  const saved = await db.store.saveVersion(scene, version(strategy), "admin"); await db.store.activate(scene, saved.id);
  const calls: Parameters<PromptOptimizer["invoke"]>[] = [];
  let optimizerResolves = 0, sourceReads = 0;
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async (_actor, input) => ({ id: input.modelConfigId, modelId: "gpt-image-2.6-sunburst", protocol: "apimart", fingerprint: input.modelConfigId }),
    resolveOptimizer: async id => { optimizerResolves++; if (!result) throw new Error("a template must not resolve any planner"); return { id, modelId: id, fingerprint: id, estimatedRmbCost: 0.01, invoke: async (...args) => { calls.push(args); return { content: result }; } }; },
    readSource: async (_actor, url) => { sourceReads++; return { bytes: Buffer.from(url), mimeType: "image/png", previewDataUrl: "data:image/png;base64,eA==" }; },
  };
  return { ...db, saved, calls, runtime, compiler: new PromptCompiler(db.store, runtime), counts: () => ({ optimizerResolves, sourceReads }) };
}
const shortResult = (prompt: string, questions: string[] = []) => JSON.stringify({ prompt, summary_zh: "按原始要求只修改指定区域。", avoid: [], keep_text: [], questions });

describe("versioned prompt-chain strategies", () => {
  test("a deterministic version needs no optimizer and still authorizes/hashes sources and preserves literals", async () => {
    const f = await fixture(); const input = request();
    const compiled = await f.compiler.compile(actor, input);
    expect(compiled).toMatchObject({ status: "success", method: "template", optimized: false, actualCost: 0, inputTokens: 0, outputTokens: 0 });
    expect(compiled.prompt).toContain("#789282"); expect(compiled.prompt).toContain("8颗纽扣"); expect(compiled.prompt).toContain("NOVA 73");
    expect(compiled.prompt).not.toContain("Avoid:"); expect(f.counts()).toEqual({ optimizerResolves: 0, sourceReads: 1 });
    expect(publicPromptCompilation(compiled)).toMatchObject({ method: "template", summaryZh: expect.any(String) });
    const prepared = await preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), operationType: "inpaint", prompt: "ignored", parameters: {}, promptInput: { ...input.promptInput, compilationId: compiled.id } });
    expect(prepared.prompt).toBe(compiled.prompt!); expect(prepared.promptCompilationId).toBe(compiled.id); expect(f.counts().optimizerResolves).toBe(0);
    expect((await f.store.stats(input.promptInput.scene)).promptQuality).toMatchObject({ measured: 1, templateCompilations: 1, avoidPhrases: 0 });
  });

  test("template previews reject changed source bytes/order/roles/user text/model and foreign owner", async () => {
    const f = await fixture(); const input = request(); input.sourceUrls.push("color"); input.promptInput.referenceRoles.push("配色参考");
    const compiled = await f.compiler.compile(actor, input);
    const reuse = { ...input, requestId: randomUUID(), promptInput: { ...input.promptInput, compilationId: compiled.id } };
    for (const changed of [
      { ...reuse, sourceUrls: ["changed", "color"] }, { ...reuse, sourceUrls: ["color", "original"] },
      { ...reuse, modelConfigId: "another-model" },
      { ...reuse, promptInput: { ...reuse.promptInput, referenceRoles: ["只参考面料", "配色参考"] } },
      { ...reuse, promptInput: { ...reuse.promptInput, userText: "新的修改" } },
    ]) await expect(f.compiler.compile(actor, changed)).rejects.toMatchObject({ code: "PROMPT_REQUEST_CHANGED" });
    await expect(f.compiler.compile({ ...actor, id: "someone-else" }, reuse)).rejects.toMatchObject({ code: "PROMPT_COMPILATION_NOT_FOUND" });
    expect(f.counts().optimizerResolves).toBe(0);
  });

  test.each([
    ["pattern-extract", { extractMode: "完整可见花型", extractBackground: "保留底色" }, "真实透明度"],
    ["style-to-sketch", { sketchStyle: "minimal", sketchDetail: "detailed" }, "可见细节"],
    ["local-restyle", { restyleArea: "领口", change: "改为小翻领", preserve: "袖型保持" }, "袖型保持"],
    ["pattern-craft", { craft: "刺绣", craftFabric: "棉布" }, "刺绣"],
    ["workflow-step", { step_type: "custom", instruction: "只调整左侧叶片" }, "左侧叶片"],
    ["series-recipe", { kind: "structure", palette: [{ name: "浅灰", hex: "#AAAAAA" }, { name: "雾青", hex: "#789282" }], positions: ["左胸", "前中"], variantIndex: 1 }, "雾青"],
    ["batch-optimize", {}, "每张独立原图"],
  ] as const)("%s uses all meaningful fields without paid expansion", async (scene, fields, contains) => {
    const f = await fixture(scene); const input = request(scene, structuredClone(fields));
    const result = await f.compiler.compile(actor, input);
    expect(result.method).toBe("template"); expect(result.status).toBe("success"); expect(result.prompt).toContain(contains); expect(f.calls).toHaveLength(0);
  });

  test("smart colors and unknown populated fields use the short planner rather than silently dropping data", async () => {
    const output = shortResult("只调整衣身为麻灰色，保留8颗纽扣及文字“NOVA 73”。");
    const f = await fixture("garment-colorway", "template-first", output);
    const input = request("garment-colorway", { colorMode: "smart", colorMood: "柔和麻灰", newBusinessField: "必须保留的特殊信息" });
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ method: "minimal", status: "success" }); expect(f.calls).toHaveLength(1);
    const payload = f.calls[0]![1][0]!;
    expect(payload.type).toBe("input_text"); expect((payload as { text: string }).text).toContain("必须保留的特殊信息");
    expect(f.calls[0]![0]).toContain("不编色号");
    expect((await f.compiler.compile(actor, { ...input, requestId: randomUUID() })).cacheHit).toBe(true); expect(f.calls).toHaveLength(1);
  });

  test("invalid known field, missing color reference and unknown source fail before any planner invocation", async () => {
    const f = await fixture();
    await expect(f.compiler.compile(actor, request("garment-colorway", { colorMode: "specific", colors: ["#invalid"] }))).rejects.toMatchObject({ code: "PROMPT_FIELDS_INVALID" });
    await expect(f.compiler.compile(actor, request("garment-colorway", { colorMode: "reference" }))).rejects.toMatchObject({ code: "PROMPT_REFERENCE_REQUIRED" });
    f.runtime.readSource = async () => { throw new Error("not your asset"); };
    await expect(f.compiler.compile(actor, request())).rejects.toThrow("not your asset"); expect(f.calls).toHaveLength(0);
  });

  test("specified color names stay literal without inventing a numeric production color", async () => {
    const f = await fixture();
    const compiled = await f.compiler.compile(actor, request("garment-colorway", { colorMode: "specific", colors: ["鼠尾草绿", "麻灰"] }));
    expect(compiled.status).toBe("success"); expect(compiled.method).toBe("template");
    expect(compiled.prompt).toContain("鼠尾草绿、麻灰"); expect(compiled.prompt).not.toMatch(/#[\da-f]{3}/i); expect(f.calls).toHaveLength(0);
  });

  test("minimal rewrite stops invented HEX, lost count and invented count, including cached admission", async () => {
    for (const [text, code] of [["衣身改成麻灰#A7A7A7，保留8颗纽扣。", "PROMPT_COLOR_INVENTED"], ["衣身改成麻灰，保留纽扣。", "PROMPT_QUANTITY_NOT_PRESERVED"], ["衣身改成麻灰，保留8颗纽扣和2个口袋。", "PROMPT_QUANTITY_INVENTED"]]) {
      const f = await fixture("free-optimize", "minimal", shortResult(text!));
      const input = request("free-optimize", {}); input.toolKey = "image-edit"; input.promptInput.userText = "衣身改成麻灰，保留8颗纽扣。";
      const result = await f.compiler.compile(actor, input); expect(result.status).toBe("failed"); expect(result.errorCode).toBe(code); expect(f.calls).toHaveLength(1);
      await f.compiler.compile(actor, input); expect(f.calls).toHaveLength(1);
    }
    const f = await fixture("free-optimize", "minimal", shortResult("衣身改成麻灰，保留8颗纽扣。"));
    const input = request("free-optimize", {}); input.toolKey = "image-edit"; input.promptInput.userText = "衣身改成麻灰，保留8颗纽扣。";
    const result = await f.compiler.compile(actor, input);
    await f.store.database.query("UPDATE prompt_compilations SET details=$1 WHERE id=$2", [JSON.stringify({ ...result, prompt: "麻灰#A7A7A7，保留8颗纽扣。" }), result.id]);
    await expect(f.compiler.compile(actor, { ...input, promptInput: { ...input.promptInput, compilationId: result.id } })).rejects.toMatchObject({ code: "PROMPT_COLOR_INVENTED" }); expect(f.calls).toHaveLength(1);
  });

  test("clarification is visible, cached and cannot enqueue a generation", async () => {
    const questions = ["“这里”指领口还是门襟？"];
    const f = await fixture("free-optimize", "minimal", shortResult("这里改窄。", questions));
    const input = request("free-optimize", {}); input.toolKey = "image-edit"; input.promptInput.userText = "这里改窄。";
    const result = await f.compiler.compile(actor, input);
    expect(publicPromptCompilation(result).questions).toEqual(questions);
    await expect(preparePromptTaskInput(f.compiler, actor, { ...input, requestId: randomUUID(), operationType: "inpaint", prompt: "这里改窄。", parameters: {}, promptInput: { ...input.promptInput, compilationId: result.id } })).rejects.toMatchObject({ code: "PROMPT_CLARIFICATION_REQUIRED" });
    expect(f.calls).toHaveLength(1); expect((await f.store.stats("free-optimize")).promptQuality?.clarifications).toBe(1);
  });

  test("shortness is measured, never enforced by truncating explicit requirements", () => {
    const long = "保留所有明确要求。".repeat(30);
    expect(promptOutputMetrics(long, { mode: "edit" }).overRecommended).toBe(true);
    expect(promptOutputMetrics("x\nAvoid: logo, watermark; collar and pocket", { mode: "edit" }).avoidPhrases).toBe(4);
    expect(() => assertMinimalPromptFidelity("保留8颗纽扣，颜色#AABBCC。", "保留8颗纽扣，颜色#abc。")).not.toThrow();
  });

  test("minimal counts understand Chinese/English and do not treat reference numbers as confirmed counts", () => {
    for (const text of ["将图片1领口改蓝，保留五枚纽扣。", "Recolor image 1 collar; retain five buttons.", "参照图片2配色，保留2个口袋。"]) {
      expect(() => assertMinimalPromptFidelity(text, "图片1为原衬衫，图片2只供颜色。领口改蓝，结构不变。" )).toThrow("未经确认的数量");
    }
    for (const [source, output] of [["保留五枚纽扣。", "保留纽扣。"], ["Keep five buttons.", "Keep buttons."]]) {
      expect(() => assertMinimalPromptFidelity(output!, source!)).toThrow("未保留明确指定的数量");
    }
    expect(() => assertMinimalPromptFidelity("Preserve five buttons and 2 pockets.", "保留五枚纽扣与两个口袋。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("添加一朵花。", "添加单朵花。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("Keep one pocket.", "Keep a single pocket.")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("图片2仅作颜色参考，在左胸添加一行文字 SUMMER 2026。", "图片2仅作颜色参考，在左胸添加一行文字 'SUMMER 2026'。")).not.toThrow();
  });
});
