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

  test.each([
    {
      name: "Sol exact-lettering output with a whitespace description", language: "zh" as const,
      source: "在图一穿着者左胸添加小字刺绣，文字为“NOVA 73”，保持准确大小写与空格。图一款式、配色、按扣、口袋和白底不变。",
      prompt: "在图片1的穿着者左胸（画面右侧）添加小字刺绣“NOVA 73”，准确保留大写字母和一个空格。款式、配色、按扣、口袋及白色背景保持不变。",
      summary: "在图片1的穿着者左胸添加“NOVA 73”小字刺绣，保持款式、配色、按扣、口袋及白底不变。", keepText: ["NOVA 73"],
    },
    {
      name: "Sol English output with placket snaps and both pockets", language: "en" as const,
      source: "只把图一领口改成深棕色，保持衣身与袖口的原米色、所有拼接位置和4颗门襟按扣。保留2个口袋及每个口袋1颗按扣。请用英文写出最终图像编辑提示词。",
      prompt: "Recolor only the ribbed collar in Image 1 to dark brown, preserving its shape and knit texture. Keep the body and cuffs their original beige. Leave all panel seams and the placket unchanged, retaining all 4 placket snaps and both pockets with 1 snap each.",
      summary: "仅将图片1的罗纹领口改为深棕色，保留衣身和袖口的原米色、所有拼接位置、门襟上的4颗按扣，以及2个各有1颗按扣的口袋。", keepText: [],
    },
    {
      name: "Sol English output with a separate on-each-pocket clause", language: "en" as const,
      source: "只把图一领口改成深棕色，保持衣身与袖口的原米色、所有拼接位置和4颗门襟按扣。保留2个口袋及每个口袋1颗按扣。请用英文写出最终图像编辑提示词。",
      prompt: "Recolor only the ribbed collar in Image 1 to dark brown, leaving the placket unchanged. Keep the body and cuffs their original beige, preserve all panel seam positions, and retain all 4 placket snaps and both pockets, with 1 snap on each pocket.",
      summary: "仅将图片1的罗纹领口改为深棕色，保持衣身与袖口原米色、所有拼接位置、门襟及其4颗按扣，并保留2个口袋和每个口袋的1颗按扣。", keepText: [],
    },
    {
      name: "Sol English output with the complete snap-button noun", language: "en" as const,
      source: "只把图一领口改成深棕色，保持衣身与袖口的原米色、所有拼接位置和4颗门襟按扣。保留2个口袋及每个口袋1颗按扣。请用英文写出最终图像编辑提示词。",
      prompt: "In Image 1, recolor only the beige ribbed collar to dark brown, preserving its ribbed texture. Keep the body and cuffs their original beige. Leave all panel seams in their original positions and retain the 4 placket snap buttons and both pockets, with 1 snap button on each pocket.",
      summary: "仅将图片1的罗纹领口改为深棕色，保留衣身和袖口的原米色、所有拼接位置、门襟的4颗按扣，以及2个各带1颗按扣的口袋。", keepText: [],
    },
    {
      name: "Sol body-color output with separate placket and pocket snaps", language: "zh" as const,
      source: "只把图一衣身浅米色区域改成麻灰，领口和袖口仍为原米色，深棕拼接片保持不变。保留门襟4颗按扣、2个口袋，每个口袋1颗按扣；保持原版型、针织纹理和白底完整单件。",
      prompt: "仅将图片1衣身的浅米色区域改为带混色肌理的麻灰，领口和袖口保留原米色，深棕拼接片不变。保留门襟的4颗按扣和2个口袋，每个口袋保留1颗按扣。保持原版型和针织纹理，在白底上完整展示单件服装。",
      summary: "仅将衣身浅米色区域改为麻灰，保留原米色领袖口、深棕拼接、按扣与口袋数量、原版型及针织纹理，白底完整展示单件。", keepText: [],
    },
    {
      name: "Sol explicit placket-count change without changing each pocket snap", language: "zh" as const,
      source: "把图一门襟4颗按扣改成3颗，仍沿原门襟居中竖向排列。保留2个口袋及各自1颗按扣，版型、拼接、配色和针织纹理不变。",
      prompt: "将图片1门襟上的4颗按扣改为3颗，仍沿原门襟中心线竖向排列。保留2个口袋及每个口袋原有的1颗按扣，版型、拼接、配色和针织纹理不变。",
      summary: "仅将门襟按扣由4颗改为居中竖排的3颗，保留2个口袋及各自1颗按扣，版型、拼接、配色和针织纹理不变。", keepText: [],
    },
  ])("saved $name passes compilation and cached admission without calling a real provider", async ({ source, prompt, summary, keepText, language }) => {
    const raw = JSON.stringify({ prompt, summary_zh: summary, avoid: [], keep_text: keepText, questions: [] });
    const f = await fixture("free-optimize", "minimal", raw, language);
    const input = request("free-optimize", {}); input.toolKey = "image-edit"; input.promptInput.userText = source;
    const result = await f.compiler.compile(actor, input);
    expect(result).toMatchObject({ status: "success", optimized: true, prompt, keepText });
    expect((await f.compiler.compile(actor, { ...input, requestId: randomUUID(), promptInput: { ...input.promptInput, compilationId: result.id } })).status).toBe("success");
    expect(f.calls).toHaveLength(1);
  });

  test("snap aliases and both pockets preserve named counts without admitting swapped or invented counts", () => {
    const source = "保留4颗门襟按扣和2个口袋，每个口袋1颗按扣。";
    for (const output of [
      "Keep 4 placket snaps and both pockets with 1 snap each.",
      "Keep four placket press-studs and both pockets with one press-stud each.",
      "Keep four placket press studs and two pockets with one press stud each.",
      "Keep 4 placket snaps and both pockets, with 1 snap on each pocket.",
    ]) expect(() => assertMinimalPromptFidelity(output, source)).not.toThrow();
    for (const output of [
      "Keep placket snaps and both pockets with 1 snap each.",
      "Keep 4 placket snaps and pockets with 1 snap each.",
      "Keep 4 placket snaps and both pockets.",
      "Keep 5 placket snaps and both pockets with 1 snap each.",
      "Keep 2 placket snaps and 4 pockets with 1 snap each.",
      "Keep 1 placket snap and both pockets with 4 snaps each.",
      "Keep 1 placket snap and both pockets, with 4 snaps on each pocket.",
      "Keep 4 placket snaps and 1 pocket, with 2 snaps on each pocket.",
      "Keep 4 placket snaps and both pockets, with 1 snap on each sleeve.",
    ]) expect(() => assertMinimalPromptFidelity(output, source)).toThrow();
    expect(() => assertMinimalPromptFidelity("Keep 4 snaps and both pockets.", "保留4颗按扣和口袋。")).toThrow("未经确认的数量");
    expect(() => assertMinimalPromptFidelity("Keep two press-studs and four pockets.", "保留4颗按扣和2个口袋。")).toThrow("数量与对象");
    expect(() => assertMinimalPromptFidelity("保留3颗门襟按扣和2个口袋，每个口袋保留1颗按扣。", "把4颗门襟按扣改成3颗，保留2个口袋及各自1颗按扣。")).not.toThrow();
    expect(() => assertMinimalPromptFidelity("保留1颗门襟按扣和2个口袋，每个口袋保留3颗按扣。", "把4颗门襟按扣改成3颗，保留2个口袋及各自1颗按扣。")).toThrow();
  });

  test.each([
    ["snaps", "snap"], ["snap buttons", "snap button"],
    ["press-studs", "press-stud"], ["press studs", "press stud"],
  ])("complete %s nouns preserve only the actual per-pocket relation", (plural, single) => {
    const source = "保留4颗门襟按扣和2个口袋，每个口袋1颗按扣。";
    for (const relation of [`both pockets with 1 ${single} each`, `both pockets, with 1 ${single} on each pocket`]) {
      expect(() => assertMinimalPromptFidelity(`Keep 4 placket ${plural} and ${relation}.`, source)).not.toThrow();
    }
    for (const output of [
      `Keep 1 placket ${single} and both pockets, with 4 ${plural} on each pocket.`,
      `Keep 4 placket ${plural} and both pockets, with 1 ${single} on each sleeve.`,
      `Keep 4 placket ${plural} and 1 pocket, with 2 ${plural} on each pocket.`,
      `Keep 4 placket ${plural} and both pockets, with 5 ${plural} on each pocket.`,
    ]) expect(() => assertMinimalPromptFidelity(output, source)).toThrow();
  });

  test("whitespace descriptions do not waive unrelated quantities or literal lettering", async () => {
    const source = "文字为“NOVA 73”，保持准确空格，款式和口袋不变。";
    expect(() => assertMinimalPromptFidelity("文字为“NOVA 73”，保留一个空格，新增3个口袋。", source)).toThrow("未经确认的数量");
    expect(() => assertMinimalPromptFidelity("文字为“NOVA 73”，保留一个空格。", "文字为“NOVA 73”，保留3个口袋。")).toThrow("未保留明确指定的数量");
    const f = await fixture("free-optimize", "minimal", JSON.stringify({ prompt: "添加文字“NOVA73”，保持款式和口袋不变。", summary_zh: "添加指定文字。", avoid: [], keep_text: ["NOVA 73"], questions: [] }));
    const input = request("free-optimize", {}); input.promptInput.userText = source;
    expect(await f.compiler.compile(actor, input)).toMatchObject({ status: "failed", errorCode: "PROMPT_TEXT_NOT_PRESERVED" });
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
