import { describe, expect, test } from "bun:test";
import { buildCreativeImageCatalog, parseCreativeChatPlan } from "@/lib/creative-chat";
import type { ToolResponseResult } from "@/services/api/image";

const source = { id: "garment", name: "garment.png", kind: "image" as const, dataUrl: "data:image/png;base64,AQID" };
const palette = { ...source, id: "palette", name: "palette.png", dataUrl: "data:image/png;base64,AgID" };
const catalog = buildCreativeImageCatalog([{ id: "upload", role: "user", content: "原图", attachments: [source] }, { id: "v2", role: "assistant", content: "生成", generatedImages: [{ ...source, id: "result", parentId: "garment", workNote: { summary: "蓝色毛衫", keep: ["蓝色", "白底"] } }] }, { id: "color", role: "user", content: "参考", attachments: [palette] }]);
const references = catalog.map(image => ({ id: image.id, name: image.name, dataUrl: image.dataUrl, type: image.type }));
const response = (args: Record<string, unknown>): ToolResponseResult => ({ content: "改成参考配色", toolCalls: [{ id: "edit", type: "function", function: { name: "edit_image", arguments: JSON.stringify(args) } }] });
const options = { catalog, selectedImageId: "result", previewedImageIds: references.map(image => image.id) };

describe("simple creative image execution", () => {
    test("ordered original references and human labels match the actual execution prompt", () => {
        const plan = parseCreativeChatPlan(response({ prompt: "把当前毛衫改为参考图配色", references: ["图3"], keep: ["版型", "白底"], note_update: "绿色毛衫" }), references, options);
        if (plan.kind !== "image") throw new Error("expected image plan");
        expect(plan.references.map(image => image.id)).toEqual(["result", "palette"]);
        expect(plan.references.map(image => image.dataUrl)).toEqual([source.dataUrl, palette.dataUrl]);
        expect(plan.prompt).toContain("输入图1对应图2（修改底图）");
        expect(plan.prompt).toContain("输入图2对应图3（参考图）");
        expect(plan.parentId).toBe("result");
        expect(plan.workId).toBe("garment");
        expect(plan.workNote).toMatchObject({ summary: "绿色毛衫", keep: ["版型", "白底"] });
        expect(plan.prompt).not.toContain("editContract");
    });
    test("explicit reference choices cannot be dropped by the planner", () => {
        const plan = parseCreativeChatPlan(response({ prompt: "改配色" }), references, { ...options, referenceImageIds: ["palette"] });
        expect(plan).toMatchObject({ references: [{ id: "result" }, { id: "palette" }] });
    });
    test("a model may explicitly clear stale keep requirements, omitted keep inherits them", () => {
        expect(parseCreativeChatPlan(response({ prompt: "改绿色", keep: [] }), references, options)).toMatchObject({ workNote: { keep: [] } });
        expect(parseCreativeChatPlan(response({ prompt: "只缩Logo" }), references, options)).toMatchObject({ workNote: { keep: ["蓝色", "白底"] } });
    });
    test("a new work never inherits old notes or preservation constraints", () => {
        expect(parseCreativeChatPlan(response({ base: "none", prompt: "新画帽子" }), references, options)).toMatchObject({ action: "generate", references: [], workNote: { keep: [] } });
    });
    test("explicit new creation cannot be switched back by a conflicting model base", () => {
        const plan = parseCreativeChatPlan(response({ base: "garment", prompt: "画新帽子" }), references, { ...options, newCreation: true });
        expect(plan).toMatchObject({ kind: "image", action: "generate", references: [] });
        expect(plan.kind === "image" && plan.parentId).toBeUndefined();
    });
    test("duplicate references, unpreviewed sources, malformed legacy fields and oversized prompts fail closed", () => {
        expect(() => parseCreativeChatPlan(response({ prompt: "改色", references: ["palette", "palette"] }), references, options)).toThrow();
        expect(() => parseCreativeChatPlan(response({ prompt: "改色", references: ["palette"] }), references, { ...options, previewedImageIds: ["result"] })).toThrow("先查看");
        expect(() => parseCreativeChatPlan(response({ prompt: "改色", superseded_constraints: [] }), references, options)).toThrow("未授权参数");
        expect(() => parseCreativeChatPlan(response({ prompt: "改".repeat(20_000), keep: ["白底"] }), references, options)).toThrow("超过 20000");
    });
});
