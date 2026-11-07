import { expect, test } from "bun:test";
import { prepareChatImageCorrection } from "../src/pages/chat/chat-image-review";
import { buildCreativeImageCatalog } from "../src/lib/creative-chat";
import type { ChatGeneratedImage } from "../src/pages/chat/chat-types";

const media = (id: string) => ({ id, name: `${id}.png`, dataUrl: `data:image/png;base64,${btoa(id)}`, mimeType: "image/png" });
const catalog = buildCreativeImageCatalog([
    { role: "user", content: "", attachments: [media("original"), media("palette")] },
    { role: "assistant", content: "", generatedImages: [{ ...media("previous"), parentId: "original" }] },
]);
const result: ChatGeneratedImage = { ...media("out"), parentId: "previous", prompt: "旧完整描述", workNote: { summary: "", keep: ["纽扣数量"] },
    spec: { changes: ["袖口改罗纹"], reference_roles: [{ image_id: "previous", role: "base", purpose: "底图" }, { image_id: "palette", role: "color", purpose: "配色" }] },
    review: { reviewedAt: "", baseUnavailable: false, baseImageId: "previous", report: { summary: "需要核对", checks: [{ criterion: "袖口", result: "warning", evidence: "局部线条不清" }, { criterion: "纽扣数", result: "unverifiable", evidence: "被遮挡" }] } },
};
test("correction is a draft rooted in exact generation base, with existing auxiliary identities", () => {
    const prepared = prepareChatImageCorrection(result, catalog);
    expect(prepared.base.id).toBe("previous");
    expect(prepared.references.map(image => image.id)).toEqual(["palette"]);
    expect(prepared.prompt).toContain(`原修改要求：${result.prompt}`);
    expect(prepared.prompt).toContain("纽扣数量");
    expect(prepared.prompt).toContain("待核对线索");
    expect(prepared.prompt).not.toContain("验收通过");
    expect(result.parentId).toBe("previous");
});
test("missing exact base never silently substitutes original or latest", () => {
    expect(() => prepareChatImageCorrection(result, catalog.filter(image => image.id !== "previous"))).toThrow("实际底图不可用");
});
test("missing auxiliary reference refuses without dropping it", () => {
    expect(() => prepareChatImageCorrection(result, catalog.filter(image => image.id !== "palette"))).toThrow("参考图不可用");
});
test("no report or no uncertain checks does not invent correction work", () => {
    expect(() => prepareChatImageCorrection({ ...result, review: undefined }, catalog)).toThrow("先检查");
    expect(() => prepareChatImageCorrection({ ...result, review: { ...result.review!, report: { summary: "符合", checks: [{ criterion: "袖口", result: "pass", evidence: "看到罗纹" }] } } }, catalog)).toThrow("没有提出");
});

test("the exact submitted references survive absent optional edit specs", () => {
    const image = { ...result, spec: undefined, referenceImageIds: ["previous", "palette", "palette"] };
    const prepared = prepareChatImageCorrection(image, catalog);
    expect(prepared.base.id).toBe("previous");
    expect(prepared.references.map(reference => reference.id)).toEqual(["palette"]);
    expect(prepared.prompt).toContain(`原修改要求：${image.prompt}`);
    expect(image.referenceImageIds).toEqual(["previous", "palette", "palette"]);
});

test("submitted references are authoritative over optional spec roles, including an explicit empty list", () => {
    const image = { ...result, referenceImageIds: ["previous", "original"] };
    expect(prepareChatImageCorrection(image, catalog).references.map(reference => reference.id)).toEqual(["original"]);
    expect(prepareChatImageCorrection({ ...image, referenceImageIds: [] }, catalog).references).toEqual([]);
    expect(() => prepareChatImageCorrection({ ...image, referenceImageIds: ["previous", "missing"] }, catalog)).toThrow("参考图不可用");
});

test("a spec summary never replaces the full public prompt or its confirmed requirements", () => {
    const prompt = "[已确认需求卡]\n深蓝色、三颗银扣、NOVA 字样。\n[局部保护]\n只改袖口，其他像素保持。\n[当前要求]\n袖口改罗纹。";
    const prepared = prepareChatImageCorrection({ ...result, prompt }, catalog);
    expect(prepared.prompt).toContain(`原修改要求：${prompt}`);
    expect(prepared.prompt).not.toContain("原修改要求：袖口改罗纹");
});

test.each([undefined, "", "  \n "])("missing full public prompt %j refuses instead of reconstructing it from a spec", (prompt) => {
    expect(() => prepareChatImageCorrection({ ...result, prompt }, catalog)).toThrow("完整原要求不可用");
});
