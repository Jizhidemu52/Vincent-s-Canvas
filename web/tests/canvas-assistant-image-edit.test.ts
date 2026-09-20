import { expect, test } from "bun:test";
import { canvasImageEditContext, resolveCanvasImageEdit, type CanvasImageEditLineage } from "@/lib/canvas/canvas-assistant-image-edit";
import { buildCanvasConversationHistory } from "@/lib/canvas/canvas-assistant-history";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";

const original: CanvasAssistantReference = { id: "source", type: CanvasNodeType.Image, title: "原始照片", dataUrl: "data:image/png;base64,ORIGINAL", storageKey: "image:original" };
const lineage: CanvasImageEditLineage = { intent: "new", originalReferences: [original], originalPrompt: "白底，人物服装不变", editPrompt: "仅换成纯白背景，保留人物服装", baseReferences: [original] };
const result = (id: string, imageEdit = lineage): CanvasAssistantMessage => ({ id, role: "assistant", text: "已生成", detail: { kind: "agent_generation", status: "completed", imageEdit, prompt: imageEdit.editPrompt }, attachments: [{ id, name: id, mediaType: "image", url: `data:image/png;base64,${id}`, storageKey: `image:${id}` }] });
const ctx = canvasImageEditContext([result("v1")]);

test("round 1: correction uses original bytes even when the model requests the bad result", () => {
    let readWrongRefs = false;
    const edit = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "恢复原有袖口，保持白底" }, ctx, () => { readWrongRefs = true; return ctx.results; }, "袖口改错了，改回来");
    expect(readWrongRefs).toBe(false);
    expect(edit.references.map(ref => ref.dataUrl)).toEqual([original.dataUrl]);
    expect(edit.references[0]?.storageKey).toBe("image:original");
    expect(edit.prompt).toContain("白底，人物服装不变");
    expect(edit.prompt).toContain("袖口改错了");
});

test("round 2: refinement uses latest result, not lingering selected originals", () => {
    const edit = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "改善灯光与留白" }, ctx, () => [original], "再好看一点");
    expect(edit.references[0]?.dataUrl).toBe("data:image/png;base64,v1");
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:original");
    expect(edit.prompt).toContain("保留已经做好的部分");
});

test("round 3: correction after refinement and reload still returns to first original", () => {
    const refinement = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "优化光线" }, ctx, () => [], "再好看点");
    const reloaded = JSON.parse(JSON.stringify([result("v1"), result("v2", refinement.lineage)]));
    const edit = resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "恢复衣服原色并保留光线优化" }, canvasImageEditContext(reloaded), () => [], "颜色改错了");
    expect(edit.references[0]?.dataUrl).toBe(original.dataUrl);
    expect(edit.prompt).toContain("优化光线");
    expect(edit.prompt).not.toContain("data:image/");
});

test("round 4: explicit base and new work reset the root without borrowing the previous task", () => {
    const different = { ...original, id: "other", storageKey: "image:other", dataUrl: "data:image/png;base64,OTHER" };
    for (const editIntent of ["new", "explicit"]) {
        const edit = resolveCanvasImageEdit({ editIntent, prompt: "调整新图" }, ctx, () => [different], "用这张新图开始");
        const next = canvasImageEditContext([result("other-v1", edit.lineage)]);
        expect(next.originals[0]?.dataUrl).toBe(different.dataUrl);
        expect(next.originalPrompt).toBe("用这张新图开始");
        expect(edit.prompt).not.toContain("白底");
    }
});

test("missing intent, unavailable originals, and ambiguous result selections fail before generation", () => {
    expect(() => resolveCanvasImageEdit({ prompt: "修图" }, ctx, () => [], "修图")).toThrow("editIntent");
    expect(() => resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "修图" }, canvasImageEditContext([]), () => ctx.results, "修图")).toThrow("原图");
    const multiple = { ...ctx, results: [...ctx.results, { ...ctx.results[0]!, id: "v1-b" }] };
    expect(() => resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "美化" }, multiple, () => [], "美化")).toThrow("选择一张");
    expect(resolveCanvasImageEdit({ editIntent: "refine_latest", resultImageId: "v1-b", prompt: "美化" }, multiple, () => [], "美化").references[0]?.id).toBe("v1-b");
    expect(() => resolveCanvasImageEdit({ editIntent: "refine_latest", resultImageId: "missing", prompt: "美化" }, multiple, () => [], "美化")).toThrow();
});

test("failed attempts and text replies never replace successful image lineage", () => {
    const history: CanvasAssistantMessage[] = [result("v1"), { ...result("failed"), role: "error", detail: { status: "failed" } }, { id: "reply", role: "assistant", text: "分析" }];
    expect(canvasImageEditContext(history).results[0]?.id).toBe("v1");
});

test("explicitly correcting the latest result honors the override without losing its first original", () => {
    const edit = resolveCanvasImageEdit({ editIntent: "explicit", prompt: "直接在上一版修袖口" }, ctx, () => ctx.results, "别回原图，用上一版改");
    expect(edit.references[0]?.storageKey).toBe("image:v1");
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:original");
});

test("old originals and latest results are seen even outside the 24-message window; source stays intact", async () => {
    const history: CanvasAssistantMessage[] = [result("v1"), ...Array.from({ length: 30 }, (_, i): CanvasAssistantMessage => ({ id: `chat-${i}`, role: "user", text: "讨论" }))];
    const context = canvasImageEditContext(history);
    const before = JSON.stringify(history);
    const conversation = await buildCanvasConversationHistory(history, { id: "now", role: "user", text: "袖口改错了", contextReferences: [...context.originals, ...context.results] }, async ref => `data:image/jpeg;base64,PREVIEW-${ref.storageKey}`);
    const content = JSON.stringify(conversation.currentContent);
    expect(content).toContain("PREVIEW-image:original");
    expect(content).toContain("PREVIEW-image:v1");
    expect(JSON.stringify(history)).toBe(before);
    expect(resolveCanvasImageEdit({ editIntent: "correct_original", prompt: "修正袖口" }, context, () => [], "修正").references[0]?.dataUrl).toBe(original.dataUrl);
});

test("portable cloud media rewrites saved lineage assets and retains semantic fields", async () => {
    const saved = await portableCanvasMedia(result("v1"), async source => `https://canvas.example/api/assets/${source.storageKey?.replace(":", "-")}`);
    const persisted = saved.detail?.imageEdit as CanvasImageEditLineage;
    expect(persisted.originalReferences[0]?.dataUrl).toBe("https://canvas.example/api/assets/image-original");
    expect(persisted.originalReferences[0]?.storageKey).toBeUndefined();
    expect(persisted.originalPrompt).toBe(lineage.originalPrompt);
    expect(canvasImageEditContext([saved]).results[0]?.dataUrl).toContain("image-v1");
});
