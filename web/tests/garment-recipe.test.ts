import { describe, expect, test } from "bun:test";

import { buildGarmentRecipe, GARMENT_BRIEF_TEXT_LIMIT, garmentReferencesMatch, garmentScenarios, type GarmentBrief, type GarmentScenario } from "../src/lib/garment-recipe";
import type { ReferenceImage } from "../src/types/image";

const image = (id: string, extra: Partial<ReferenceImage> = {}): ReferenceImage => ({ id, name: `${id}.png`, type: "image/png", dataUrl: `https://images.test/${id}.png`, ...extra });
const brief = (scenario: GarmentScenario, extra: Partial<GarmentBrief> = {}): GarmentBrief => ({ scenario, primaryId: "garment", target: "按指定区域调整设计", preserve: "保留针织质感", ...extra });
const references = () => [image("unused"), image("other-garment"), image("garment")];
const scenarios = ["colorway", "restyle"] as const;

describe("applied garment references", () => {
    test("accepts the same ordered image sources restored as new objects", () => {
        const applied = [image("garment"), image("other-garment")];
        expect(garmentReferencesMatch(applied, applied.map((item) => ({ ...item })))).toBe(true);
        expect(garmentReferencesMatch([], [])).toBe(true);
    });

    test("rejects reordered, deleted and extra references", () => {
        const applied = [image("garment"), image("other-garment")];
        expect(garmentReferencesMatch(applied, [...applied].reverse())).toBe(false);
        expect(garmentReferencesMatch(applied, [applied[0]!])).toBe(false);
        expect(garmentReferencesMatch(applied, [applied[1]!])).toBe(false);
        expect(garmentReferencesMatch(applied, [...applied, image("extra")])).toBe(false);
        expect(garmentReferencesMatch(applied, [])).toBe(false);
        expect(garmentReferencesMatch([], [image("garment")])).toBe(false);
    });

    test.each(["id", "dataUrl", "url", "storageKey", "sourceAssetId"] as const)("rejects a changed %s even when all other source fields match", (field) => {
        const applied = [image("garment", { url: "/api/assets/garment/content", storageKey: "image:garment", sourceAssetId: "asset-garment" })];
        const current = [{ ...applied[0]!, [field]: "replacement-source" }];
        expect(garmentReferencesMatch(applied, current)).toBe(false);
    });

    test.each(["dataUrl", "url", "storageKey", "sourceAssetId"] as const)("treats missing and empty %s as the same absent source", (field) => {
        const applied = [image("garment", { [field]: undefined })];
        const current = [image("garment", { [field]: "" })];
        expect(garmentReferencesMatch(applied, current)).toBe(true);
        expect(garmentReferencesMatch(current, applied)).toBe(true);
    });

    test("ignores display metadata changes without mutating either snapshot", () => {
        const applied = [image("garment")];
        const current = applied.map((item) => ({ ...item, name: "renamed.png", originalFileName: "original.png", imageName: "renamed", imageVersion: 2, type: "image/webp", bytes: 512, width: 100, height: 200, origin: "template", originLabel: "模板", referenceKey: `template:${item.id}` }));
        const snapshot = structuredClone({ applied, current });
        applied.forEach(Object.freeze);
        current.forEach(Object.freeze);
        Object.freeze(applied);
        Object.freeze(current);
        expect(garmentReferencesMatch(applied, current)).toBe(true);
        expect({ applied, current }).toEqual(snapshot);
    });
});

describe("garment scenario recipes", () => {
    test("exposes only the two single-garment workflows with complete form copy", () => {
        expect(garmentScenarios.map((item) => item.id)).toEqual(scenarios);
        expect(garmentScenarios.every((item) => item.title && item.description && item.targetLabel && item.targetPlaceholder && item.limitation)).toBe(true);
        expect(garmentScenarios.every((item) => !("secondaryLabel" in item) && !("requiresSecondary" in item))).toBe(true);
    });

    test("colorway applies the requested color while keeping structure, texture and conceptual boundaries", () => {
        const recipe = buildGarmentRecipe(brief("colorway", { target: "衣身改成 #A6C8D8，领口保留奶白", preserve: "保留袖口和针织质感" }), references());
        expect(recipe.title).toBe("服装换色");
        expect(recipe.references.map((item) => item.id)).toEqual(["garment"]);
        expect(recipe.prompt).toContain("图片1是服装主图，也是唯一参考图");
        expect(recipe.prompt).toContain("衣身改成 #A6C8D8，领口保留奶白");
        expect(recipe.prompt).toContain("保留袖口和针织质感");
        expect(recipe.prompt).toContain("服装廓形、结构、比例");
        expect(recipe.prompt).toContain("未指定部位保留原色");
        expect(recipe.prompt).toContain("纹理");
        expect(recipe.prompt).toContain("不保证精确色值");
        expect(recipe.prompt).toContain("概念配色");
    });

    test("restyle changes only the specified design and preserves other regions", () => {
        const recipe = buildGarmentRecipe(brief("restyle", { target: "圆领改翻领", preserve: "保留袖口和衣长" }), references());
        expect(recipe.title).toBe("服装改款");
        expect(recipe.references.map((item) => item.id)).toEqual(["garment"]);
        expect(recipe.prompt).toContain("圆领改翻领");
        expect(recipe.prompt).toContain("保留袖口和衣长");
        expect(recipe.prompt).toContain("对目标未涉及的区域");
        expect(recipe.prompt).toContain("不擅自扩大改动范围");
        expect(recipe.prompt).toContain("不是纸样、工艺单");
        expect(recipe.prompt).toContain("概念效果");
    });

    test.each(scenarios)("%s sends only the selected primary image, never unselected references", (scenario) => {
        const input = references();
        const recipe = buildGarmentRecipe(brief(scenario), input);
        expect(recipe.references).toEqual([input[2]!]);
        expect(recipe.prompt).not.toContain("图片2");
        expect(recipe.prompt).not.toContain("unused");
        expect(recipe.prompt).not.toContain("other-garment");
        expect(recipe.prompt).toContain("保留项优先");
    });
});

describe("stable garment image bindings", () => {
    test.each(scenarios)("%s selects by stable ID after the reference tray is reordered", (scenario) => {
        const input = references();
        const request = brief(scenario);
        const original = buildGarmentRecipe(request, input);
        expect(buildGarmentRecipe(request, [...input].reverse())).toEqual(original);
        expect(buildGarmentRecipe(request, [input[1]!, input[2]!, input[0]!])).toEqual(original);
        expect(original.references.map((item) => item.id)).toEqual(["garment"]);
    });

    test("deleted primary binding is rejected instead of falling back to the first remaining image", () => {
        expect(() => buildGarmentRecipe(brief("colorway"), references().filter((item) => item.id !== "garment"))).toThrow(/服装主图.*已移除或不存在/);
    });

    test("a new image at the old visual position cannot take over a deleted binding", () => {
        const input = references().map((item) => item.id === "garment" ? image("replacement") : item);
        expect(() => buildGarmentRecipe(brief("restyle"), input)).toThrow(/服装主图.*已移除或不存在/);
    });

    test("duplicate selected IDs are rejected even when their source URLs differ", () => {
        expect(() => buildGarmentRecipe(brief("colorway"), [image("garment"), image("garment", { dataUrl: "https://images.test/other.png" })])).toThrow("ID 重复");
    });

    test("duplicate unused IDs cannot create an ambiguous reference registry", () => {
        expect(() => buildGarmentRecipe(brief("colorway"), [image("garment"), image("unused"), image("unused")])).toThrow("ID 重复");
    });

    test("does not mutate the brief or reference inputs and returns a detached reference object", () => {
        const request = brief("restyle");
        const input = references();
        const snapshot = structuredClone({ request, input });
        Object.freeze(request);
        input.forEach(Object.freeze);
        Object.freeze(input);
        const recipe = buildGarmentRecipe(request, input);
        expect({ request, input }).toEqual(snapshot);
        expect(recipe.references).not.toBe(input);
        expect(recipe.references[0]).not.toBe(input[2]);
        recipe.references[0]!.name = "changed-output.png";
        recipe.references.push(image("output-only"));
        expect({ request, input }).toEqual(snapshot);
    });
});

describe("garment brief validation", () => {
    test("rejects unsupported scenarios and malformed brief values with readable errors", () => {
        expect(() => buildGarmentRecipe(brief("unsupported" as GarmentScenario), references())).toThrow(/有效.*服装/);
        expect(() => buildGarmentRecipe(null as unknown as GarmentBrief, references())).toThrow(/有效.*服装/);
        expect(() => buildGarmentRecipe(brief("restyle", { target: 12 as unknown as string }), references())).toThrow("格式不正确");
        expect(() => buildGarmentRecipe(brief("restyle", { preserve: null as unknown as string }), references())).toThrow("格式不正确");
    });

    test.each(scenarios)("%s requires a nonblank target without inventing one", (scenario) => {
        expect(() => buildGarmentRecipe(brief(scenario, { target: "" }), references())).toThrow("请填写");
        expect(() => buildGarmentRecipe(brief(scenario, { target: " \n\t " }), references())).toThrow("请填写");
    });

    test("preserves Unicode, multiline instructions and punctuation, trimming only outer whitespace", () => {
        const target = "领口改成 V 领\n保留‘靛蓝’与 #3A5B9C，印花文字为「海风」 🌊";
        const recipe = buildGarmentRecipe(brief("restyle", { target: `  ${target}\n`, preserve: "  袖型\n针织肌理  " }), references());
        expect(recipe.prompt).toContain(`设计目标：\n${target}\n\n`);
        expect(recipe.prompt).toContain("用户明确要求保留：\n袖型\n针织肌理\n\n");
    });

    test.each(["", " \n\t "])("accepts blank optional preservation and keeps the scenario defaults: %j", (preserve) => {
        const recipe = buildGarmentRecipe(brief("colorway", { preserve }), references());
        expect(recipe.prompt).toContain("无额外保留要求；遵守上述场景的默认保留范围");
    });

    test.each(["target", "preserve"] as const)("%s accepts exactly 2000 characters and rejects 2001 without truncation", (field) => {
        expect(GARMENT_BRIEF_TEXT_LIMIT).toBe(2000);
        const accepted = "设".repeat(2000);
        expect(buildGarmentRecipe(brief("restyle", { [field]: accepted }), references()).prompt).toContain(accepted);
        expect(() => buildGarmentRecipe(brief("restyle", { [field]: `${accepted}计` }), references())).toThrow("不能超过 2000 个字符");
    });

    test("rejects empty references and missing primary selection", () => {
        expect(() => buildGarmentRecipe(brief("restyle"), [])).toThrow("请先添加服装主图");
        expect(() => buildGarmentRecipe(brief("restyle", { primaryId: "" }), references())).toThrow("请选择服装主图");
        expect(() => buildGarmentRecipe(brief("restyle", { primaryId: " " }), references())).toThrow("请选择服装主图");
        expect(() => buildGarmentRecipe(brief("restyle"), [image("")])).toThrow("缺少有效 ID");
    });

    test.each(["", "   ", "data:image/png;base64,", "data:text/plain;base64,AA==", "data:image/png;base64", "data:;base64,AA=="])("rejects empty or invalid selected image content: %s", (dataUrl) => {
        expect(() => buildGarmentRecipe(brief("restyle"), [image("garment", { dataUrl })])).toThrow(/图片内容/);
    });

    test("accepts inline image content and storage-only or url-backed application references", () => {
        const inline = image("garment", { dataUrl: "data:image/png;base64,AA==" });
        const storageBacked = image("garment", { dataUrl: "", storageKey: "image:stored" });
        const urlBacked = image("garment", { dataUrl: "", url: "/api/assets/stored/content" });
        for (const reference of [inline, storageBacked, urlBacked]) {
            expect(buildGarmentRecipe(brief("restyle"), [reference]).references).toEqual([reference]);
        }
    });

    test("does not fall back to an unselected usable image when the selected image has no content", () => {
        const input = [image("garment", { dataUrl: "" }), image("other-garment")];
        expect(() => buildGarmentRecipe(brief("restyle"), input)).toThrow(/服装主图.*图片内容/);
    });

    test("rejects non-image MIME types even when storage is available", () => {
        expect(() => buildGarmentRecipe(brief("restyle"), [image("garment", { type: "text/plain" })])).toThrow("服装主图不是图片");
        expect(() => buildGarmentRecipe(brief("restyle"), [image("garment", { type: "application/pdf", dataUrl: "", storageKey: "image:stored" })])).toThrow("服装主图不是图片");
    });
});
