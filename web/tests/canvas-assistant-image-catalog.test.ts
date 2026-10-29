import { expect, test } from "bun:test";
import { canvasConversationImages, canvasConversationImageForAsset, canvasConversationOriginals, canvasConversationTarget } from "@/lib/canvas/canvas-assistant-image-catalog";
import { resolveCanvasImageEdit, type CanvasImageEditLineage } from "@/lib/canvas/canvas-assistant-image-edit";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";

const source: CanvasAssistantReference = { id: "source", type: CanvasNodeType.Image, title: "原图", storageKey: "image:source", dataUrl: "data:image/png;base64,SOURCE" };
const oldLineage: CanvasImageEditLineage = { intent: "new", originalReferences: [source], originalPrompt: "背景改白色", editPrompt: "Make the background white.", baseReferences: [source], contract: { changes: [{ id: "background", text: "Make the background white.", source: "背景改白色" }], preserve: [], forbid: [] } };
const result = (id: string, lineage = oldLineage): CanvasAssistantMessage => ({ id: `message-${id}`, role: "assistant", text: "已生成", detail: { status: "completed", imageEdit: lineage }, attachments: [{ id, name: id, mediaType: "image", url: `data:image/png;base64,${id}`, storageKey: `image:${id}` }] });
const history: CanvasAssistantMessage[] = [
    { id: "upload", role: "user", text: "背景改白色", references: [source] }, result("old"),
    { id: "repeat", role: "user", text: "继续讨论", references: [source] },
    result("latest", { ...oldLineage, originalPrompt: "另一项任务", originalReferences: [{ ...source, id: "other", storageKey: "image:other" }], contract: { changes: [{ id: "other", text: "Make a blue dress.", source: "另一项任务" }], preserve: [], forbid: [] } }),
];

test("catalog numbering survives display truncation and repeated references without using mutable node IDs", () => {
    const catalog = canvasConversationImages(history);
    expect(catalog.map(image => [image.label, image.name])).toEqual([["图1", "原图"], ["图2", "old"], ["图3", "latest"]]);
    expect(canvasConversationImageForAsset(catalog, "repeat", source)?.label).toBe("图1");
    expect(canvasConversationImageForAsset(catalog, "message-old", { id: "old", storageKey: "image:old" })?.label).toBe("图2");
    const extended = canvasConversationImages([...history, { id: "changed-source", role: "user", text: "新版本", references: [{ ...source, dataUrl: "data:image/png;base64,CHANGED", storageKey: "image:changed" }] }]);
    expect(extended.slice(0, 3).map(image => image.id)).toEqual(catalog.map(image => image.id));
    expect(extended[3]?.label).toBe("图4");
    expect(extended[3]?.reference.storageKey).toBe("image:changed");
});

test("two frozen snapshots with the same node ID still select their own original pixels", () => {
    const messages: CanvasAssistantMessage[] = [{ id: "snapshots", role: "user", text: "对照", references: [source, { ...source, title: "另一版", storageKey: "image:changed", dataUrl: "data:image/png;base64,CHANGED" }] }];
    const images = canvasConversationImages(messages);
    expect(new Set(images.map(image => image.id)).size).toBe(2);
    const selected = canvasConversationTarget(messages, images[1]!, "edit");
    expect(selected.target.reference.storageKey).toBe("image:changed");
    expect(canvasConversationImageForAsset(images, "snapshots", messages[0]!.references![1]!)?.label).toBe("图2");
});

test("selecting an old result freezes that result's contract and originals instead of the latest task", () => {
    const before = JSON.stringify(history);
    const image = canvasConversationImages(history)[1]!;
    const selected = canvasConversationTarget(history, image, "edit");
    expect(selected.context.results.map(ref => ref.id)).toEqual(["old"]);
    expect(selected.context.originals[0]?.storageKey).toBe("image:source");
    expect(selected.context.contract?.changes[0]?.id).toBe("background");
    const edit = resolveCanvasImageEdit({ editIntent: "new", resultImageId: "latest", prompt: "Brighten the lighting.", editContract: {
        mode: "update", changes: [{ id: "lighting", text: "Brighten the lighting.", source: "再亮一点" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "old", role: "base" }],
    } }, selected.context, () => [{ ...source, id: "wrong" }], "再亮一点", selected.target);
    expect(edit.references.map(ref => ref.storageKey)).toEqual(["image:old"]);
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:source");
    expect(edit.lineage.contract?.changes.map(clause => clause.id)).toEqual(["background", "lighting"]);
    expect(JSON.stringify(history)).toBe(before);
});

test("an explicitly selected result remains the base alongside supplemental references without resetting its contract", () => {
    const selected = canvasConversationTarget(history, canvasConversationImages(history)[1]!, "edit");
    selected.target.additionalReferences = [{ ...source, id: "pattern", title: "花型参考", storageKey: "image:pattern" }];
    const edit = resolveCanvasImageEdit({ editIntent: "explicit", prompt: "Use the supplied pattern.", editContract: {
        mode: "update", changes: [{ id: "pattern", text: "Use the supplied pattern.", source: "参考花型" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "old", role: "base" }, { id: "pattern", role: "pattern" }],
    } }, selected.context, () => [], "参考花型", selected.target);
    expect(edit.references.map(ref => ref.id)).toEqual(["old", "pattern"]);
    expect(edit.lineage.originalReferences[0]?.storageKey).toBe("image:source");
    expect(edit.lineage.contract?.changes.map(clause => clause.id)).toEqual(["background", "pattern"]);
});

test("return to originals keeps every original and does not let the planner replace them with the result", () => {
    const multiple = result("multi", { ...oldLineage, originalReferences: [source, { ...source, id: "back", title: "背面", storageKey: "image:back" }] });
    const messages = [...history, multiple];
    const catalog = canvasConversationImages(messages), image = catalog.at(-1)!;
    expect(canvasConversationOriginals(image, messages, catalog).map(item => item.storageKey)).toEqual(["image:source", "image:back"]);
    const selected = canvasConversationTarget(messages, image, "original");
    const edit = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "Improve the lighting.", editContract: {
        mode: "update", changes: [{ id: "lighting", text: "Improve the lighting.", source: "调整亮度" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "edit-original-0", role: "base" }, { id: "edit-original-1", role: "base" }],
    } }, selected.context, () => selected.context.results, "调整亮度", selected.target);
    expect(edit.references.map(ref => ref.storageKey)).toEqual(["image:source", "image:back"]);
});

test("missing selected assets fail before generation and raw reference edits start their own task", () => {
    const catalog = canvasConversationImages(history);
    expect(() => canvasConversationTarget([], catalog[1]!, "edit")).toThrow("编辑目标");
    expect(() => canvasConversationTarget(history, catalog[0]!, "original")).toThrow("原图");
    const selected = canvasConversationTarget(history, catalog[0]!, "edit");
    const edit = resolveCanvasImageEdit({ editIntent: "refine_latest", prompt: "Brighten the image.", editContract: {
        mode: "complete", changes: [{ id: "lighting", text: "Brighten the image.", source: "变亮" }], preserve: [], forbid: [], supersedes: [], referenceRoles: [{ id: "source", role: "base" }],
    } }, selected.context, () => [], "变亮", selected.target);
    expect(edit.references.map(ref => ref.storageKey)).toEqual(["image:source"]);
    expect(edit.lineage.originalPrompt).toBe("变亮");
    expect(edit.lineage.contract?.changes.map(clause => clause.id)).toEqual(["lighting"]);
});
