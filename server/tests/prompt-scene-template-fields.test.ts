import { describe, expect, test } from "bun:test";
import type { PromptInput, PromptScene } from "../../shared/prompt-contracts";
import { normalizePromptFields } from "../src/prompt-compiler";
import { compileSceneTemplate } from "../src/prompt-scene-templates";

function compile(scene: PromptScene, fields: Record<string, unknown>, userText = "", references = 1, language: "zh" | "en" = "zh", requiredText: string[] = []) {
  const roles = ["原图：保留字样 NOVA 73", "只参考图案；不参考颜色"].slice(0, references);
  const input: PromptInput = { scene, fields: structuredClone(fields), userText, referenceRoles: roles, mode: "edit", hasMask: false };
  return compileSceneTemplate(input, normalizePromptFields(input), references, roles, language, requiredText);
}
const selectedColor = { id: "qtc-42", name: "用户选择的色库标签 17-0001", hex: "#AABBCC", library: "用户选择的色库", sourceUrl: "https://example.invalid/colors/42", source: "public-screen-palette", datasetVersion: "2026-11" };
const seriesFields = () => ({ kind: "structure", series: "DO_NOT_PRINT_PROJECT_NAME", constraints: "保留 6 颗纽扣和 12 cm 袋口", prompt: "拉链改为同色，文字 NOVA 73 不变", count: 3,
  palette: [{ name: "配色 1", hex: "#112233" }, { name: "自选色 2", hex: "#AABBCC" }, { name: "配色 3", hex: "#445566" }],
  paletteStyle: "soft", positions: ["前中", "左胸 12 cm", "下摆"], variantIndex: 1, hasMotif: false });

describe("deterministic scene field coverage", () => {
  test.each(["garment-colorway", "pattern-colorway"] as const)("%s routes unexpected color mood or incompatible palette input to the minimal planner", scene => {
    for (const fields of [
      { colorMode: "specific", colors: ["#AABBCC"], colorMood: "柔和且冷暖交错" },
      { colorMode: "reference", colors: ["#AABBCC"] },
      { colors: ["#AABBCC"] },
    ]) expect(compile(scene, fields, "只调整颜色", 2)).toBeUndefined();
  });

  test("garment color aliases preserve the requested area and fail closed for an additional structural change", () => {
    const output = compile("garment-colorway", { colorMode: "specific", colors: ["鼠尾草绿"], restyleArea: "6 颗纽扣" }, "纽扣改色，背景改为白色");
    expect(output?.prompt).toContain("6 颗纽扣");
    expect(output?.prompt).toContain("纽扣改色，背景改为白色");
    expect(output?.prompt).not.toContain("辅料的数量与颜色");
    expect(output?.prompt).not.toMatch(/背景不变/);
    expect(output?.prompt).not.toMatch(/#[\da-f]{3}/i);
    expect(compile("garment-colorway", { colorMode: "specific", colors: ["红色"], change: "拆去两只口袋" }, "颜色改红")).toBeUndefined();
    expect(compile("garment-colorway", { colorMode: "specific", colors: ["红色"], restyleArea: "纽扣", colorRegion: "袖子" }, "颜色改红")).toBeUndefined();
  });

  test("selected color labels stay linked to matching HEX without sending production disclaimers to the image model", () => {
    const output = compile("garment-colorway", { colorMode: "specific", colors: ["#abc"], colorSelections: [selectedColor] });
    expect(output?.prompt).toContain(selectedColor.name);
    expect(output?.prompt).toContain(selectedColor.library);
    expect(output?.prompt).toContain("#abc");
    expect(output?.prompt).not.toContain("屏幕近似");
    expect(output?.prompt).not.toContain(selectedColor.sourceUrl);
    for (const selection of [{ ...selectedColor, hex: "#123456" }, { ...selectedColor, extraInstruction: "修改 4 个口袋" }]) {
      expect(compile("garment-colorway", { colorMode: "specific", colors: ["#abc"], colorSelections: [selection] })).toBeUndefined();
    }
    expect(compile("garment-colorway", { colorMode: "specific", colors: ["#abc"], colorSelections: [selectedColor, selectedColor] })).toBeUndefined();
  });

  test("all literal common requirements and explicit lettering survive, including target on a craft scene", () => {
    const fields = { craft: "盘金绣", craftFabric: "12 oz 牛仔布", targetProduct: "左胸徽章", description: "四边留 2 cm", instruction: "不改变 6 片花瓣", keepDetails: "线宽 1.5 mm", preserve: "边缘 8 个圆点", carryoverRequirements: ["底部 3 片叶子"], keep_text: ["  NOVA 73  "] };
    const original = structuredClone(fields);
    const output = compile("pattern-craft", fields, "保留文字“夏日 2026”", 1, "zh", ["夏日 2026"]);
    for (const literal of ["左胸徽章", "12 oz", "2 cm", "6 片", "1.5 mm", "8 个", "3 片", "  NOVA 73  ", "夏日 2026", "原图：保留字样 NOVA 73"]) expect(output?.prompt).toContain(literal);
    expect(output?.keepText).toEqual(["夏日 2026", "  NOVA 73  "]);
    expect(fields).toEqual(original);
  });

  test("series consumes the design prompt separately from userText but excludes verified project and palette-generator metadata", () => {
    const fields = seriesFields();
    const output = compile("series-recipe", fields, "所有字样位置保持");
    expect(output?.prompt).toContain(fields.prompt);
    expect(output?.prompt).toContain(fields.constraints);
    expect(output?.prompt).toContain("所有字样位置保持");
    expect(output?.prompt).toContain("#AABBCC");
    expect(output?.prompt).toContain("自选色 2");
    expect(output?.prompt).not.toContain("屏幕近似");
    expect(output?.prompt).not.toContain(fields.series);
    expect(output?.prompt).not.toContain("左胸 12 cm");
    expect(output?.prompt).not.toContain("#112233");
  });

  test.each([
    { variantIndex: -1 }, { variantIndex: 6 }, { variantIndex: 3 }, { count: 1 }, { count: "3" },
    { branch_index: 2 }, { paletteStyle: "新业务配色要求" }, { paletteStyle: { toString: null } }, { series: { design: "不能丢失" } },
    { positions: "左胸 12 cm" }, { hasMotif: true },
  ])("unrecognized or mismatched series metadata is not silently discarded: %j", changed => {
    expect(compile("series-recipe", { ...seriesFields(), ...changed }, "只修改颜色", 2)).toBeUndefined();
  });

  test("a new palette property is not silently omitted", () => {
    const fields = seriesFields(); fields.palette[1] = { ...fields.palette[1]!, extraInstruction: "分配到 3 个区域" } as never;
    expect(compile("series-recipe", fields, "只修改颜色")).toBeUndefined();
  });

  test("pattern-series does not force hidden structure palette controls into visible motif design", () => {
    const fields = { ...seriesFields(), kind: "pattern", count: 1, variantIndex: 0, hasMotif: true, prompt: "保持图案原色，缩到 12 cm", constraints: "保留主体纹理" };
    const output = compile("series-recipe", fields, "保留原色", 2);
    expect(output?.prompt).toContain("应用图片2的图案");
    expect(output?.prompt).toContain("前中");
    expect(output?.prompt).toContain("保持图案原色，缩到 12 cm");
    expect(output?.prompt).not.toContain("#112233");
    expect(output?.prompt).not.toContain("配色 1");
  });

  test("pattern-series without motif or a concrete design brief routes to the minimal planner", () => {
    expect(compile("series-recipe", { ...seriesFields(), kind: "pattern", count: 1, variantIndex: 0, prompt: "", hasMotif: false })).toBeUndefined();
  });

  test("workflow operation, title and both instruction fields are visible; prior summaries cannot override a new change", () => {
    const output = compile("workflow-step", { step_type: "recolor", step_title: "袖口调色", user_text: "仅改 2 只袖口", previous_step_summary: "衣身蓝色", instruction: "袖口改为红色" }, "衣身改为白色");
    for (const literal of ["换色", "袖口调色", "仅改 2 只袖口", "衣身蓝色", "袖口改为红色", "衣身改为白色"]) expect(output?.prompt).toContain(literal);
    expect(output?.prompt).not.toContain("保留上一步已明确完成的内容");
    expect(compile("workflow-step", { step_type: "new-custom-action", instruction: "改色" })).toBeUndefined();
  });

  test("only actual matching canvas template metadata is excluded, not arbitrary title fields", () => {
    const output = compile("garment-colorway", { templateId: "range", branchIndex: 1, title: "DO_NOT_PRINT_NODE_TITLE", instruction: "海军蓝，正面平铺，白底" }, "海军蓝，正面平铺，白底");
    expect(output?.prompt).toContain("海军蓝，正面平铺，白底");
    expect(output?.prompt).not.toContain("DO_NOT_PRINT_NODE_TITLE");
    expect(compile("garment-colorway", { title: "这里有新设计要求", instruction: "改蓝色" })).toBeUndefined();
    expect(compile("garment-colorway", { templateId: "development", branchIndex: 0, title: "线稿", instruction: "改蓝色" })).toBeUndefined();
  });

  test("front view is explicit while unknown or unseen views use the minimal planner", () => {
    expect(compile("style-to-sketch", { views: ["front"] })?.prompt).toContain("正面");
    expect(compile("style-to-sketch", { views: ["front", "back"] })).toBeUndefined();
  });

  test("English template framing never translates literal requirements or image roles", () => {
    const output = compile("local-restyle", { restyleArea: "左袖口", change: "宽度改为 2.5 cm", keep_text: ["春日 NOVA 73"] }, "保留 6 颗纽扣及字样“春日 NOVA 73”", 2, "en", ["春日 NOVA 73"]);
    for (const literal of ["左袖口", "宽度改为 2.5 cm", "保留 6 颗纽扣及字样“春日 NOVA 73”", "原图：保留字样 NOVA 73", "只参考图案；不参考颜色"]) expect(output?.prompt).toContain(literal);
    expect(output?.keepText).toEqual(["春日 NOVA 73"]);
  });

  test.each([
    { language: "zh", roles: ["图片1：待改色原衬衫", "图片2：只参考图片1右袖的纹理"], expected: ["图片1：待改色原衬衫", "图片2：只参考图片1右袖的纹理"] },
    { language: "zh", roles: ["图片1：图片1：待改色原衬衫", " Image 2: 只参考图片1的颜色"], expected: ["图片1：待改色原衬衫", "图片2：只参考图片1的颜色"] },
    { language: "en", roles: ["Image 1: original shirt", "Image 2: use Image 1's outline"], expected: ["Image 1：original shirt", "Image 2：use Image 1's outline"] },
    { language: "en", roles: ["图片1：字样“春日 2026”保持", "图2：只参考图片1的轮廓"], expected: ["Image 1：字样“春日 2026”保持", "Image 2：只参考图片1的轮廓"] },
    { language: "zh", roles: ["图片2：颜色参考，不改变图片1结构", "说明：图片2：只参考颜色"], expected: ["图片1：图片2：颜色参考，不改变图片1结构", "图片2：说明：图片2：只参考颜色"] },
    { language: "zh", roles: ["图片10：对比图，保持图片1数量"], expected: ["图片1：图片10：对比图，保持图片1数量"] },
  ] as const)("normalizes only matching leading image headings: %j", ({ language, roles, expected }) => {
    const fields = { colorMode: "specific", colors: ["蓝色"] };
    const input: PromptInput = { scene: "garment-colorway", fields, userText: "只改颜色", referenceRoles: [...roles], mode: "edit", hasMask: false };
    const originalRoles = [...roles];
    const output = compileSceneTemplate(input, fields, roles.length, roles, language, []);
    expect(output?.prompt.split("\n").slice(0, roles.length)).toEqual([...expected]);
    expect([...roles]).toEqual(originalRoles);
  });

  test.each(["zh", "en"] as const)("color and series templates keep selected colors but omit nonvisual disclaimers in %s", language => {
    for (const scene of ["garment-colorway", "pattern-colorway", "series-recipe"] as const) {
      const fields = scene === "series-recipe" ? seriesFields() : { colorMode: "specific", colors: ["#AABBCC"], colorSelections: [selectedColor] };
      const output = compile(scene, fields, "保留所有字样", 1, language);
      expect(output?.prompt).toContain("#AABBCC");
      expect(output?.prompt).not.toMatch(/屏幕近似|生产色标|实物色差保证|on-screen color|production standard|color-match guarantee/);
    }
  });

  test.each(["zh", "en"] as const)("craft templates preserve defaults without contradicting explicitly allowed multi-image rearrangement in %s", language => {
    const request = "将图片1和图片2的花朵组合为一组，只调整整体排布，各花朵内部形状、颜色和数量不变。";
    const output = compile("pattern-craft", { craft: "刺绣", preserve: "各花朵内部结构保持" }, request, 2, language);
    expect(output?.prompt).toContain(request);
    expect(output?.prompt).toContain("各花朵内部结构保持");
    expect(output?.prompt).toContain(language === "zh" ? "未明确允许调整的相对位置保持不变，组合或重排仅限明确指定的范围" : "Keep relative positions unchanged except within the explicitly allowed scope of composition or rearrangement");
    expect(output?.prompt).not.toMatch(/在原构图内|within the original composition/);
    expect(output?.summaryZh).not.toContain("不裁切或重新排列");
  });
});
