import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promptRecipeVersionSchema, promptScenes, type PromptCompilationRequest, type PromptRecipeVersionContent, type PromptScene } from "../../shared/prompt-contracts";
import { sqlitePromptRecipeStore } from "../src/demo-prompt-recipes";
import { PromptCompiler, type PromptCompilerRuntime, type PromptOptimizer } from "../src/prompt-compiler";
import { assertVideoMotionTimeline, parseOptimizedPrompt } from "../src/prompt-safety";
import { buildSolPromptRecipeContent, SOL_PROMPT_MODEL_ID, SOL_PROMPT_RECIPE_KEYS } from "../src/sol-prompt-recipes";

const original = (patch: Partial<PromptRecipeVersionContent> = {}): PromptRecipeVersionContent => ({
  systemPrompt: "OLD RULE: only prompt, avoid and keep_text. Generate approximate HEX. Translate silently.",
  fieldTemplate: "Existing custom field mapping.",
  modelOverrides: { "target-image": "Keep the exact visible product lettering." },
  fallbackPrompt: "An existing administrator-owned fallback.",
  outputLanguage: "zh",
  changeNote: "Existing administrator note.",
  ...patch,
});

const templateCases: Array<{ scene: PromptScene; fields: Record<string, unknown>; expected: string }> = [
  { scene: "garment-colorway", fields: { colorMode: "specific", colors: ["#789282"], colorRegion: "大身" }, expected: "#789282" },
  { scene: "pattern-colorway", fields: { colorMode: "specific", colors: ["奶油白"], colorRegion: "花瓣" }, expected: "花瓣" },
  { scene: "style-to-sketch", fields: { sketchStyle: "technical", sketchDetail: "detailed" }, expected: "全部可见细节" },
  { scene: "local-restyle", fields: { restyleArea: "领口", change: "改成小翻领" }, expected: "小翻领" },
  { scene: "pattern-extract", fields: { extractMode: "完整可见花型", extractBackground: "保留底色" }, expected: "真实透明度" },
  { scene: "pattern-craft", fields: { craft: "刺绣", craftFabric: "棉布" }, expected: "棉布" },
  { scene: "series-recipe", fields: { kind: "structure", palette: [{ name: "雾青", hex: "#789282" }], count: 1, variantIndex: 0 }, expected: "#789282" },
  { scene: "workflow-step", fields: { step_type: "custom", user_text: "只修正领口" }, expected: "只修正领口" },
  { scene: "print-placement", fields: { position: "胸前", size: "保持原图比例", style: "线描" }, expected: "胸前" },
  { scene: "garment-presentation", fields: { presentation: "白底平铺" }, expected: "白底平铺" },
  { scene: "batch-optimize", fields: {}, expected: "每张独立原图" },
];
const shortResult = (prompt: string, questions: string[] = []) => JSON.stringify({ prompt, summary_zh: "按明确要求处理指定区域。", avoid: [], keep_text: [], questions });
const close: Array<() => void> = [];
afterEach(() => close.splice(0).forEach(dispose => dispose()));

async function fixture(scene: PromptScene, response?: string) {
  const db = sqlitePromptRecipeStore(":memory:");
  close.push(db.close);
  await db.store.ensure(scene, { name: scene, enabled: true, modelConfigId: response ? "sol-config" : null, failurePolicy: "stop" });
  const rules = buildSolPromptRecipeContent(scene, original({ fieldTemplate: "", modelOverrides: {}, fallbackPrompt: "" }));
  const saved = await db.store.saveVersion(scene, rules, "isolated-unit-test");
  await db.store.activate(scene, saved.id);
  const calls: Parameters<PromptOptimizer["invoke"]>[] = [];
  let resolves = 0;
  const runtime: PromptCompilerRuntime = {
    resolveTarget: async () => ({ id: "target", modelId: "gpt-image-2.6-sunburst", protocol: "apimart", fingerprint: "target" }),
    resolveOptimizer: async id => {
      resolves++;
      if (!response) throw new Error("A deterministic recipe must not resolve an optimizer");
      return { id, modelId: SOL_PROMPT_MODEL_ID, fingerprint: "sol", estimatedRmbCost: null,
        invoke: async (...args) => { calls.push(args); return { content: response }; } };
    },
    readSource: async (_actor, url) => ({ bytes: Buffer.from(url), mimeType: "image/png", previewDataUrl: "data:image/png;base64,eA==" }),
  };
  const input: PromptCompilationRequest = { requestId: randomUUID(), modelConfigId: "target", sourceUrls: ["reference"],
    promptInput: { scene, fields: {}, userText: "按明确要求处理指定区域。", referenceRoles: ["原图"], mode: scene === "video-motion" ? "video" : "edit", hasMask: false } };
  return { compiler: new PromptCompiler(db.store, runtime), input, calls, resolves: () => resolves };
}
const actor = { id: "sol-recipe-employee", role: "designer" };

describe("Sol prompt recipe versions", () => {
  test("the model identity and rewritten set are exact", () => {
    expect(SOL_PROMPT_MODEL_ID).toBe("gpt-6.2-sol");
    expect([...SOL_PROMPT_RECIPE_KEYS]).toEqual([...promptScenes]);
    expect(new Set(SOL_PROMPT_RECIPE_KEYS).size).toBe(19);
    expect(() => buildSolPromptRecipeContent("unreviewed-new-scene", original())).toThrow("Unsupported Sol prompt recipe");
    expect(() => buildSolPromptRecipeContent("__proto__", original())).toThrow("Unsupported Sol prompt recipe");
  });

  test.each(["creative-chat", "canvas-assistant"])("dormant %s is retained without a body or strategy rewrite", key => {
    const previous = original();
    const next = buildSolPromptRecipeContent(key, previous);
    expect(next).toEqual(previous);
    expect(next).not.toBe(previous);
    expect(next.executionStrategy).toBeUndefined();
    next.modelOverrides["target-image"] = "Mutating a returned draft";
    expect(previous.modelOverrides["target-image"]).toBe("Keep the exact visible product lettering.");
  });

  test.each([...promptScenes])("%s preserves administrator-owned data and replaces contradictory prose", scene => {
    const previous = original();
    const before = structuredClone(previous);
    Object.freeze(previous.modelOverrides);
    Object.freeze(previous);
    const next = buildSolPromptRecipeContent(scene, previous);
    expect(previous).toEqual(before);
    expect(promptRecipeVersionSchema.parse(next)).toEqual(next);
    for (const field of ["fieldTemplate", "modelOverrides", "fallbackPrompt", "outputLanguage"] as const) expect(next[field]).toEqual(before[field]);
    expect(next.modelOverrides).not.toBe(previous.modelOverrides);
    expect(next.systemPrompt).not.toContain("OLD RULE");
    expect(next.systemPrompt).not.toContain("Generate approximate HEX");
    expect(next.systemPrompt).not.toContain("Translate silently");
    expect(next.systemPrompt).not.toMatch(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/i);
    expect(next.systemPrompt).not.toContain("通用禁止项");
    expect(next.systemPrompt).not.toContain("prompt、avoid、keep_text 三个字段");
    expect(buildSolPromptRecipeContent(scene, next)).toEqual(next);
    if (scene === "reverse-prompt" || scene === "video-motion") {
      expect(next.executionStrategy).toBe("llm");
      expect(next.systemPrompt).toContain("prompt、summary_zh 两个字段");
      expect(next.systemPrompt).not.toContain("五个字段");
    } else {
      expect(next.executionStrategy).toBe(templateCases.some(item => item.scene === scene) ? "template-first" : "minimal");
      expect(next.systemPrompt).toContain("prompt、summary_zh、avoid、keep_text、questions 五个字段");
      expect(next.systemPrompt).not.toContain("两个字段");
    }
  });

  test.each(["en", "zh"] as const)("%s remains the configured output language", outputLanguage => {
    for (const scene of promptScenes) expect(buildSolPromptRecipeContent(scene, original({ outputLanguage })).outputLanguage).toBe(outputLanguage);
  });

  test("scene rules bind the actual form fields and retain domain-specific boundaries", () => {
    const form = readFileSync(new URL("../../web/src/pages/creative/scene-form-model.ts", import.meta.url), "utf8");
    const requirements: Array<{ scene: PromptScene; fields: string[]; phrases: string[] }> = [
      { scene: "text-to-style", fields: ["category", "silhouette", "fabric", "presentation"], phrases: ["不虚构原图", "部件数量"] },
      { scene: "back-design", fields: ["backStructure", "backMotif"], phrases: ["设计推演", "不机械镜像前身"] },
      { scene: "accessory-design", fields: ["accessoryType", "accessoryApply"], phrases: ["必要功能", "不带入其服装"] },
      { scene: "garment-colorway", fields: ["colorMode", "colorRegion", "colorMood", "colors", "colorSelections"], phrases: ["已匹配", "只提供配色"] },
      { scene: "pattern-colorway", fields: ["colorMode", "colorRegion", "colorMood"], phrases: ["真实透明区域", "不供形状"] },
      { scene: "pattern-extract", fields: ["extractMode", "extractBackground"], phrases: ["裁切边界", "不自动做无缝循环"] },
      { scene: "pattern-craft", fields: ["craft", "craftFabric"], phrases: ["不固定把图片1当作唯一图案来源", "四边留出边距"] },
      { scene: "sketch-to-photo", fields: ["fabric", "colorDescription", "presentation"], phrases: ["图片1是结构来源", "不称为恢复真实原色"] },
      { scene: "virtual-try-on", fields: ["description"], phrases: ["不带入源人物身份", "不推断真实尺码"] },
    ];
    for (const { scene, fields, phrases } of requirements) {
      const body = buildSolPromptRecipeContent(scene, original()).systemPrompt;
      for (const field of fields) { expect(form).toMatch(new RegExp(`\\b${field}\\??:`)); expect(body).toContain(field); }
      for (const phrase of phrases) expect(body).toContain(phrase);
    }
    const motionInput = readFileSync(new URL("../../web/src/pages/video/video-motion.ts", import.meta.url), "utf8");
    const motion = buildSolPromptRecipeContent("video-motion", original()).systemPrompt;
    for (const field of ["video_mode", "duration", "generate_audio"]) { expect(motionInput).toContain(field); expect(motion).toContain(field); }
    expect(motion).toContain("不声称看过全片");
    expect(motion).toContain("终点等于 duration 秒");
    expect(motion).toContain("generate_audio=false");
  });
});

describe("Sol recipes against the real compiler without network", () => {
  test.each(templateCases)("$scene keeps its deterministic zero-call path", async ({ scene, fields, expected }) => {
    const f = await fixture(scene);
    f.input.promptInput.fields = fields;
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "template", optimized: false, inputTokens: 0, outputTokens: 0, actualCost: 0 });
    expect(result.prompt).toContain(expected);
    expect(f.resolves()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  test.each(["garment-colorway", "pattern-colorway"] as const)("%s uses exactly the visible preset without resolving or calling an optimizer", async scene => {
    const f = await fixture(scene);
    f.input.promptInput.fields = { colorMode: "smart", colorMood: "自然柔和", presetColors: "雾蓝、沙色、暖灰", colorRegion: "衣身", keepDetails: "袖口保持原色" };
    f.input.promptInput.outputLanguage = "zh";
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "template", optimized: false, actualCost: 0 });
    for (const text of ["雾蓝、沙色、暖灰", "衣身", "袖口保持原色"]) expect(result.prompt).toContain(text);
    expect(f.resolves()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  test("a legacy smart-color request without a visible preset preserves its original planning contract", async () => {
    const f = await fixture("garment-colorway", shortResult("将衣身调整为协调的低饱和颜色，袖口保持原色。"));
    f.input.promptInput.fields = { colorMode: "smart", colorMood: "自然柔和", colorRegion: "衣身", keepDetails: "袖口保持原色" };
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "minimal", optimized: true, questions: [] });
    expect(f.calls).toHaveLength(1);
    const [system, content] = f.calls[0]!;
    expect(system).toContain("五个字段");
    expect(system).not.toContain("必须且只能包含 prompt、avoid、keep_text；");
    expect(content[0]).toMatchObject({ type: "input_text" });
    if (content[0]?.type !== "input_text") throw new Error("Expected structured design input");
    expect(JSON.parse(content[0].text).fields).toEqual(f.input.promptInput.fields);
  });

  test("free optimization preserves exact lettering, quantities and language in its final C5 output", async () => {
    const prompt = 'Keep 4 buttons and 2 pockets; print "NOVA 73" on the wearer\'s left chest.';
    const response = JSON.stringify({ prompt, summary_zh: "保留部件并添加指定印字。", avoid: [], keep_text: ["NOVA 73"], questions: [] });
    const f = await fixture("free-optimize", response);
    f.input.promptInput.userText = '保留4颗纽扣和2个口袋，在穿着者左胸印字“NOVA 73”。';
    f.input.promptInput.outputLanguage = "en";
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "minimal", prompt, questions: [] });
    expect(f.calls).toHaveLength(1);
    const input = f.calls[0]![1][0];
    if (input?.type !== "input_text") throw new Error("Expected structured design input");
    expect(JSON.parse(input.text).output_language).toBe("en");
  });

  test("clarification remains a complete C5 result and old C3 output is rejected", async () => {
    const prompt = "只调整指定部位的颜色。";
    const f = await fixture("free-optimize", shortResult(prompt, ["需要调整哪个部位？"]));
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", questions: ["需要调整哪个部位？"] });
    const legacy = await fixture("free-optimize", JSON.stringify({ prompt, avoid: [], keep_text: [] }));
    expect(await legacy.compiler.compile(actor, legacy.input)).toMatchObject({ status: "failed", errorCode: "PROMPT_OUTPUT_INVALID" });
  });

  test("visible motif counts are preserved without adding unconfirmed row or column numbers", async () => {
    const input = "把图一完整可见花型提取成二维平面图案，保留所有可见元素数量与相对位置，不补全画面外内容。";
    const invented = await fixture("free-optimize", shortResult("将图一花型整理为6列×4行的二维图案，保留原位置。"));
    invented.input.promptInput.userText = input;
    expect(await invented.compiler.compile(actor, invented.input)).toMatchObject({ status: "failed", errorCode: "PROMPT_QUANTITY_INVENTED" });
    expect(invented.calls[0]![0]).toContain("用户未给出的部件、元素、行列计数，不从看图主动写成新增数字");
    const faithful = await fixture("free-optimize", shortResult("将图一完整可见花型展平为二维图案，保持参考图的可见数量、相对位置与裁切边界，不补画画外内容。"));
    faithful.input.promptInput.userText = input;
    expect(await faithful.compiler.compile(actor, faithful.input)).toMatchObject({ status: "success", method: "minimal", questions: [] });
  });

  test.each(["reverse-prompt", "video-motion"] as const)("%s uses its two-field contract without image-contract contamination", async scene => {
    const prompt = scene === "video-motion" ? "以图片1为首帧。0-2秒：人物自然侧身，镜头固定；2-5秒：人物站稳，镜头平稳推近袖口。" : "一件米色针织开衫，正面平铺，表面纹理清晰。";
    const f = await fixture(scene, JSON.stringify({ prompt, summary_zh: "自然展示产品的可见细节。" }));
    if (scene === "video-motion") f.input.promptInput.fields = { duration: 5, video_mode: "first-frame", generate_audio: false };
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", optimized: true, prompt });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]![0]).toContain("两个字段");
    expect(f.calls[0]![0]).not.toContain("五个字段");
    expect(f.calls[0]![0]).not.toContain("必须且只能包含 prompt、avoid、keep_text；");
    if (scene === "video-motion") expect(() => assertVideoMotionTimeline(prompt, 5)).not.toThrow();
  });

  test("video instructions do not weaken timeline or response checks", () => {
    const rules = [buildSolPromptRecipeContent("video-motion", original()).systemPrompt];
    const options = { video: true, referenceCount: 1, userText: "", language: "zh" as const };
    const prompt = "以图片1为首帧。0-2秒：人物侧身；3-5秒：人物站稳。";
    expect(() => assertVideoMotionTimeline(prompt, 5)).toThrow();
    expect(() => assertVideoMotionTimeline("0-2.5秒：侧身；2.5-5秒：站稳。", 5)).toThrow();
    expect(() => parseOptimizedPrompt(JSON.stringify({ prompt, summary_zh: "展示衣服。", avoid: [] }), rules, options)).toThrow();
  });
});

describe("pattern-craft framing through the real compiler", () => {
  const framingCases = [
    {
      language: "zh" as const,
      closeUp: "只展示中央花瓣的局部特写，允许裁切图案，不展示完整图案。",
      defaultRequest: "呈现刺绣工艺，保留原图案的颜色与元素关系。",
      roles: ["只提供棉布材质，不取其图案", "只提供花朵图案，不取其底布"],
      conditionalDefault: /(?:未指定|未明确|没有)[^。\n]{0,60}(?:完整入镜|完整图案)[^。\n]{0,80}(?:边距|留白)/u,
    },
    {
      language: "en" as const,
      closeUp: "Show only the central petal as a cropped close-up; allow the motif to extend outside the frame.",
      defaultRequest: "Render the embroidery while preserving the motif colors and arrangement.",
      roles: ["Cotton fabric texture only; do not take its motif", "Flower motif only; do not take its fabric"],
      conditionalDefault: /\bonly\s+(?:if|when)\b[^.\n]{0,60}\b(?:unspecified|not\s+specified|no\s+(?:framing|composition))\b[^.\n]{0,120}\b(?:complete|full)\b[^.\n]{0,120}\b(?:margins|space)\b/iu,
    },
  ];

  test.each(framingCases)("$language explicit cropped close-up overrides default full framing without an LLM", async ({ language, closeUp, conditionalDefault }) => {
    const f = await fixture("pattern-craft");
    f.input.promptInput.outputLanguage = language;
    f.input.promptInput.userText = closeUp;
    f.input.promptInput.fields = { description: closeUp, craft: "刺绣", craftFabric: "棉布" };
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "template", optimized: false, inputTokens: 0, outputTokens: 0, actualCost: 0, questions: [] });
    expect(result.prompt).toContain(closeUp);
    expect(result.prompt).toMatch(conditionalDefault);
    expect(result.summaryZh).not.toMatch(/呈现完整图案|展示完整图案|完整入镜/u);
    expect(f.resolves()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  test.each(framingCases)("$language unspecified framing keeps complete-motif margins as a conditional default", async ({ language, defaultRequest, conditionalDefault }) => {
    const f = await fixture("pattern-craft");
    f.input.promptInput.outputLanguage = language;
    f.input.promptInput.userText = defaultRequest;
    f.input.promptInput.fields = { description: defaultRequest, craft: "刺绣", craftFabric: "棉布" };
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "template", optimized: false, inputTokens: 0, outputTokens: 0, actualCost: 0, questions: [] });
    expect(result.prompt).toContain(defaultRequest);
    expect(result.prompt).toMatch(conditionalDefault);
    expect(result.summaryZh).not.toMatch(/呈现完整图案|展示完整图案|完整入镜/u);
    expect(f.resolves()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  test.each(framingCases)("$language multiple-reference roles and crop instructions survive template compilation and cache reuse", async ({ language, closeUp, roles, conditionalDefault }) => {
    const f = await fixture("pattern-craft");
    f.input.sourceUrls = ["fabric-reference", "motif-reference"];
    f.input.promptInput.outputLanguage = language;
    f.input.promptInput.referenceRoles = roles;
    f.input.promptInput.userText = closeUp;
    f.input.promptInput.fields = { description: closeUp, craft: "刺绣", craftFabric: "棉布" };
    const result = await f.compiler.compile(actor, f.input);
    expect(result).toMatchObject({ status: "success", method: "template", optimized: false, inputTokens: 0, outputTokens: 0, actualCost: 0, questions: [] });
    expect(result.prompt).toContain(closeUp);
    for (const [index, role] of roles.entries()) expect(result.prompt).toContain(`${language === "zh" ? "图片" : "Image "}${index + 1}：${role}`);
    expect(result.prompt).toMatch(conditionalDefault);
    expect(result.summaryZh).not.toMatch(/呈现完整图案|展示完整图案|完整入镜/u);
    const reused = await f.compiler.compile(actor, { ...f.input, requestId: randomUUID(), promptInput: { ...f.input.promptInput, compilationId: result.id } });
    expect(reused).toMatchObject({ id: result.id, status: "success", method: "template", prompt: result.prompt, summaryZh: result.summaryZh });
    expect(f.resolves()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
