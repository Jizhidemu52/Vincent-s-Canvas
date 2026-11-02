import { expect, test } from "bun:test";
import { assertCreativeChatImageSelection, buildCreativeImageCatalog, withCreativeChatImageSelection, type CreativeChatPlan, type CreativeImageCatalogEntry } from "@/lib/creative-chat";
import { chatImageOriginal } from "@/pages/chat/chat-image-selection";

const image = (id: string, parentImageId?: string): CreativeImageCatalogEntry => ({ id, messageId: `message-${id}`, label: `图${id}`, name: `${id}.png`, kind: "generated", dataUrl: "data:image/png;base64,AQID", type: "image/png", ...(parentImageId ? { lineage: { parentImageId, sourceImageIds: [parentImageId], preservedConstraints: [] } } : {}) });
const catalog = [image("1"), image("2", "1"), image("3", "2"), image("4", "1")];

test("return to original follows only the selected branch's complete parent chain", () => {
    expect(chatImageOriginal(catalog, "3").image?.id).toBe("1");
    expect(chatImageOriginal(catalog, "4").image?.id).toBe("1");
    expect(chatImageOriginal(catalog, "1").image?.id).toBe("1");
    expect(chatImageOriginal([image("1", "2"), image("2", "1")], "1")).toEqual({ reason: "图片血缘存在循环，无法确定原图" });
    expect(chatImageOriginal([image("3", "missing")], "3")).toEqual({ reason: "原图不在当前会话中，无法回到原图" });
    expect(chatImageOriginal([{ ...image("1"), unavailableReason: "原件缺失" }, image("2", "1")], "2")).toEqual({ reason: "原件缺失" });
});

test("explicit choices live in structured focus state and never rewrite the user's words", () => {
    const current = { id: "turn", role: "user" as const, content: "亮一点" };
    const prepared = withCreativeChatImageSelection(current, catalog, { explicitTargetImageId: "2", referenceImageIds: ["4"] });
    expect(prepared.content).toBe("亮一点");
    expect(prepared).toMatchObject({ focusImageId: "2", focusLocked: true });
    expect(current.content).toBe("亮一点");
    const uploadOnly = { ...current, content: "", attachments: [{ id: "ref", name: "参考.png", kind: "image" as const, dataUrl: "data:image/png;base64,AQID" }] };
    expect(withCreativeChatImageSelection(uploadOnly, catalog, { explicitTargetImageId: "2" })).toMatchObject({ ...uploadOnly, focusImageId: "2", focusLocked: true });
    expect(withCreativeChatImageSelection(current, catalog, {})).toBe(current);
    expect(() => withCreativeChatImageSelection(current, catalog, { explicitTargetImageId: "gone" })).toThrow("不可用");
});

test("execution validates the frozen explicit target and actual references without rewriting them", () => {
    const plan: CreativeChatPlan = { kind: "image", action: "edit", content: "", prompt: "只提亮", references: [image("2"), image("4")], parentId: "2", workNote: { summary: "提亮", keep: [] }, keep: [] };
    const selection = { explicitTargetImageId: "2", referenceImageIds: ["4"] };
    const original = structuredClone(plan);
    expect(() => assertCreativeChatImageSelection(plan, selection)).not.toThrow();
    expect(plan).toEqual(original);
    expect(() => assertCreativeChatImageSelection({ ...plan, references: [image("3"), image("4")], parentId: "3" }, selection)).toThrow("未使用选中的当前图");
    expect(() => assertCreativeChatImageSelection({ ...plan, references: [image("4"), image("2")] }, selection)).toThrow("未使用选中的当前图");
    expect(() => assertCreativeChatImageSelection({ ...plan, action: "generate", references: [] }, selection)).toThrow("未使用选中的当前图");
    expect(() => assertCreativeChatImageSelection({ ...plan, references: [image("2")] }, selection)).toThrow("缺少已选参考图");
    expect(() => assertCreativeChatImageSelection({ kind: "discussion", content: "先讨论配色" }, selection)).not.toThrow();
    expect(() => assertCreativeChatImageSelection({ ...plan, action: "generate", references: [] }, {})).not.toThrow();
});

test("reusing an existing picture as a reference preserves its identity and global label", () => {
    const history = [{ id: "original-turn", role: "assistant" as const, content: "", generatedImages: [{ id: "result", dataUrl: "data:image/png;base64,AQID" }] }];
    const current = { id: "turn", role: "user" as const, content: "参考它的色彩", attachments: [{ id: "result", kind: "image" as const, name: "参考", dataUrl: "data:image/png;base64,AQID" }] };
    const images = buildCreativeImageCatalog(history, current);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ id: "result", label: "图1", kind: "generated" });
});
