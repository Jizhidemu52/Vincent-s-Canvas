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
async function fixture(scene: PromptScene = "garment-colorway", strategy: PromptRecipeVersionContent["executionStrategy"] = "template-first", result?: string, outputLanguage: "zh" | "en" = "zh") {
  const db = sqlitePromptRecipeStore(":memory:"); close.push(db.close);
  await db.store.ensure(scene, { name: scene, enabled: true, modelConfigId: result ? "planner" : null, failurePolicy: "stop" });
  const saved = await db.store.saveVersion(scene, { ...version(strategy), outputLanguage }, "admin"); await db.store.activate(scene, saved.id);
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
  test("minimal prohibition rendering keeps exclusion metrics without exposing parser-only fields", async () => {
    const raw = JSON.stringify({ prompt: "只修改领口，保留8颗纽扣及文字“NOVA 73”", summary_zh: "只改领口。", avoid: ["不要改变背景", "水印"], keep_text: ["NOVA 73"], questions: [] });
    const f = await fixture("free-optimize", "minimal", raw);
    const input = request("free-optimize", {});
    const compiled = await f.compiler.compile(actor, input);
    expect(compiled.status).toBe("success");
    expect(compiled.prompt).toContain("\n不要改变背景\n避免: 水印.");
    expect(compiled.promptMetrics?.avoidPhrases).toBe(2);
    expect((await f.store.stats("free-optimize")).promptQuality?.avoidPhrases).toBe(2);
    expect(Object.hasOwn(compiled, "avoidForMetrics")).toBe(false);
    expect(Object.hasOwn(publicPromptCompilation(compiled), "avoidForMetrics")).toBe(false);
  });

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

  test.each(["zh", "en"] as const)("%s colorway templates preserve original colors outside explicit recoloring targets", async language => {
    for (const scene of ["garment-colorway", "pattern-colorway"] as const) {
      const f = await fixture(scene, "template-first", undefined, language);
      const input = request(scene, { colorMode: "specific", colors: ["#789282"], colorRegion: "左侧区域" });
      const result = await f.compiler.compile(actor, input);
      expect(result).toMatchObject({ method: "template", status: "success" });
      expect(result.prompt).toContain(language === "zh" ? "未明确要求改色的区域保留原颜色" : "Preserve the original colors of areas not explicitly targeted for recoloring");
      expect(result.prompt).toContain("左侧区域"); expect(result.prompt).toContain("#789282");
      expect(f.counts().optimizerResolves).toBe(0);
    }
  });

  test.each(["zh", "en"] as const)("%s local restyle keeps the source representation and framing unless explicitly changed", async language => {
    const f = await fixture("local-restyle", "template-first", undefined, language);
    const input = request("local-restyle", { restyleArea: "领口", change: "改为小翻领" });
    input.promptInput.userText = "只改领口，保留原线稿与半身构图。";
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ method: "template", status: "success" });
    expect(result.prompt).toContain(language === "zh" ? "除明确要求的修改外，保持原图表现形式、画面范围" : "Except for the explicitly requested changes, preserve the original image's representation and framing");
    expect(result.prompt).toContain(input.promptInput.userText); expect(f.counts().optimizerResolves).toBe(0);
  });

  test.each([undefined, "单独图案"])("English extraction mode %s does not imply a single motif or invent uncropped content", async extractMode => {
    const f = await fixture("pattern-extract", "template-first", undefined, "en");
    const input = request("pattern-extract", extractMode ? { extractMode } : {});
    input.promptInput.userText = "保留2朵花和4片叶子，保留裁切边界，不补画画外部分。";
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ method: "template", status: "success" });
    expect(result.prompt).toContain("Extract the specified visible pattern content");
    expect(result.prompt).not.toContain("individual motif");
    expect(result.prompt).toContain("element counts, relative positions and crop boundaries");
    expect(result.prompt).toContain("without inventing occluded or off-frame content");
    expect(result.prompt).toContain(input.promptInput.userText); expect(f.counts().optimizerResolves).toBe(0);
  });

  test.each(["zh", "en"] as const)("%s multi-reference craft follows assigned roles without making Image 1 the only artwork source", async language => {
    const f = await fixture("pattern-craft", "template-first", undefined, language);
    const input = request("pattern-craft", { craft: "刺绣", craftFabric: "棉布" });
    input.sourceUrls = ["fabric", "flowers", "leaves"];
    input.promptInput.referenceRoles = ["仅参考棉布与刺绣针法，不取图案", "花朵图案来源", "叶片图案来源"];
    input.promptInput.userText = "只组合图片2的花朵和图片3的叶片，图片1只参考面料与针法。";
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ method: "template", status: "success" });
    expect(result.prompt).toContain(language === "zh" ? "按各参考图的明确分工，把指定图案" : "Following the assigned role of each reference image, render the specified artwork");
    expect(result.prompt).not.toContain(language === "zh" ? "把图片1的图案呈现为" : "Render the artwork in Image 1 as");
    for (const role of input.promptInput.referenceRoles) expect(result.prompt).toContain(role);
    expect(result.prompt).toContain(input.promptInput.userText); expect(f.counts()).toEqual({ optimizerResolves: 0, sourceReads: 3 });

    const single = await f.compiler.compile(actor, request("pattern-craft", { craft: "刺绣" }));
    expect(single.prompt).toContain(language === "zh" ? "把图片1的图案呈现为" : "Render the artwork in Image 1 as");
    expect(f.counts().optimizerResolves).toBe(0);
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

  test("minimal rewrites cannot swap confirmed counts between garment parts or motifs", () => {
    for (const [source, output] of [
      ["保留5枚纽扣和2个口袋。", "保留2枚纽扣和5个口袋。"],
      ["Keep five buttons and two pockets.", "Keep two buttons and five pockets."],
      ["保留六片花瓣和四片叶子。", "保留四片花瓣和六片叶子。"],
    ]) expect(() => assertMinimalPromptFidelity(output!, source!)).toThrow("数量与对象");
    expect(() => assertMinimalPromptFidelity("Preserve five buttons and two pockets.", "保留5枚纽扣和两个口袋。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留六片花瓣与四片叶子。", "保留四片叶子与六片花瓣。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留纽扣和口袋。", "保留纽扣和口袋。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("把5枚纽扣减少到2枚纽扣。", "把5枚纽扣减少到2枚。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留5枚纽扣和2个口袋，不要变成2枚纽扣或5个口袋。", "保留5枚纽扣和2个口袋。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留2枚纽扣与5个口袋，增加1朵花。", "保留5枚纽扣和2个口袋，增加1朵花。")).toThrow("数量与对象");
  });

  test("explicit quantity changes admit an English elided target and a final-only result", () => {
    const english = "Reduce five buttons to two; keep three pockets.";
    for (const output of [
      "Reduce five buttons to two buttons; keep three pockets.",
      "Keep two buttons and three pockets.",
      "保留两枚纽扣与3个口袋。",
    ]) expect(() => assertMinimalPromptFidelity(output, english)).not.toThrow();
    expect(() => assertMinimalPromptFidelity("最终保留2枚纽扣。", "把5枚纽扣改为2枚纽扣。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留2枚纽扣和5个口袋。", "把5枚纽扣减少到2枚，保留5个口袋。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留5枚纽扣和3个口袋。", "把2枚纽扣增加到5枚，保留3个口袋。")).not.toThrow();
  });

  test("named quantity changes retain irregular leaf names and identical field echoes", () => {
    expect(() => assertMinimalPromptFidelity("Keep four leaves and two petals.", "Reduce six leaves to four; keep two petals.")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留2枚纽扣。", '把5枚纽扣改为2枚纽扣。\n{"change":"把5枚纽扣改为2枚纽扣。"}')).not.toThrow();
  });

  test("an explicit correction supersedes only the named previously preserved quantity", () => {
    const source = "先前要求保留5枚纽扣和2个口袋；现更正：只把纽扣改为3枚，口袋仍保留2个。";
    expect(() => assertMinimalPromptFidelity("保留3枚纽扣和2个口袋。", source)).not.toThrow();
    expect(() => assertMinimalPromptFidelity("将原5枚纽扣改为3枚纽扣，保留2个口袋。", source)).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留2枚纽扣和2个口袋。", "先前保留5枚纽扣和2个口袋；现更正：把纽扣改为2枚。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留3枚纽扣和5个口袋。", "先前保留5枚纽扣和5个口袋；现更正：把纽扣改为3枚。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("Keep three buttons and two pockets.", "Keep five buttons and two pockets. Correction: change buttons to three.")).not.toThrow();
  });

  test("quantity-change admission does not invent counts or waive other object locks", () => {
    for (const [source, output] of [
      ["Reduce five buttons to two; keep three pockets.", "Keep four buttons and three pockets."],
      ["Reduce five buttons to two; keep three pockets.", "Keep three buttons and two pockets."],
      ["把5枚纽扣改为2枚，保留2个口袋。", "保留5枚纽扣和2个口袋。"],
      ["把5枚纽扣减少到2枚，保留5个口袋。", "保留2枚纽扣。"],
      ["先前保留5枚纽扣和2个口袋；现更正：把纽扣改为3枚。", "保留2枚纽扣和3个口袋。"],
      ["先前保留5枚纽扣和5个口袋；现更正：把纽扣改为3枚。", "保留3枚纽扣。"],
      ["保留5枚纽扣，也保留8枚纽扣；现更正：把纽扣改为3枚。", "保留3枚纽扣。"],
      ["Reduce five buttons to two pockets.", "Keep two pockets."],
      ["保留5枚纽扣不变，同时改为2枚纽扣。", "保留2枚纽扣。"],
      ["保留5枚纽扣和2个口袋，不要把5枚纽扣改为2枚纽扣。", "保留2枚纽扣和2个口袋。"],
      ["添加文字 '现更正：把纽扣改为2枚'，保留5枚纽扣和2个口袋。", "添加文字 '现更正：把纽扣改为2枚'，保留2枚纽扣和2个口袋。"],
    ]) expect(() => assertMinimalPromptFidelity(output!, source!)).toThrow();
  });

  test("final quantity changes pass real compilation and cached admission still rejects the old result", async () => {
    const f = await fixture("free-optimize", "minimal", shortResult("保留2枚纽扣和2个口袋。"));
    const input = request("free-optimize", {}); input.toolKey = "image-edit";
    input.promptInput.userText = "把5枚纽扣改为2枚，保留2个口袋。";
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ status: "success", method: "minimal", prompt: "保留2枚纽扣和2个口袋。" });
    const reuse = { ...input, requestId: randomUUID(), promptInput: { ...input.promptInput, compilationId: result.id } };
    expect((await f.compiler.compile(actor, reuse)).status).toBe("success");
    await f.store.database.query("UPDATE prompt_compilations SET details=$1 WHERE id=$2", [JSON.stringify({ ...result, prompt: "保留5枚纽扣和2个口袋。" }), result.id]);
    await expect(f.compiler.compile(actor, reuse)).rejects.toMatchObject({ code: "PROMPT_QUANTITY_BINDING_CHANGED" });
    expect(f.calls).toHaveLength(1);
  });

  test("minimal rewrites reject a reversed garment side but accept an explicit image-coordinate explanation", () => {
    expect(() => assertMinimalPromptFidelity("在穿着者右胸添加文字。", "在左胸添加文字。")).toThrow("左右部位");
    expect(() => assertMinimalPromptFidelity("Change the left sleeve to blue.", "Change the right sleeve to blue.")).toThrow("左右部位");
    expect(() => assertMinimalPromptFidelity("在穿着者左胸，即正面画面右侧添加文字。", "在左胸添加文字。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("画面左侧的胸部添加文字。", "在画面左侧的胸部添加文字。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("左右袖按原要求分别改色。", "左袖改蓝，右袖改红。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("Image 1: change the right sleeve to blue.", "Change the left sleeve to blue.")).toThrow("左右部位");
    expect(() => assertMinimalPromptFidelity("将图案移到右胸。", "将图案从左胸移到右侧胸部。")).not.toThrow();
  });
});
