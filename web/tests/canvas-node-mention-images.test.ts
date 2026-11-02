import { expect, test } from "bun:test";
import { appendCanvasMentionImage, canvasMentionImageIndex, configMentionInputs } from "@/lib/canvas/canvas-node-mention-images";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { toCanvasStoredImageReference } from "@/lib/canvas/canvas-image-references";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { cloneCanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import type { ConversationImageItem } from "@/components/conversation-image-controls";

const canvas: ConversationImageItem = { id: "canvas:source", label: "图1", name: "画布原图", storageKey: "image:source", dataUrl: "blob:source", source: "canvas" };
const conversation: ConversationImageItem = { id: "reply-image", label: "图8", name: "对话结果", storageKey: "image:reply", dataUrl: "asset:reply", source: "conversation" };

test("explicit node mention references preserve source identity and use current request position", () => {
    const first = appendCanvasMentionImage([], canvas)!;
    const second = appendCanvasMentionImage(first.references, conversation)!;
    expect(first.reference).toMatchObject({ id: "source", referenceKey: "canvas:source", origin: "canvas", originLabel: "画布图片" });
    expect(second.reference).toMatchObject({ id: "conversation:reply-image", referenceKey: "conversation:reply-image", storageKey: "image:reply", originLabel: "对话图片" });
    expect(second.index).toBe(1);
    expect(first.references).toHaveLength(1);
});

test("conversation IDs cannot alias an unrelated canvas node; storage aliases still dedupe", () => {
    const first = appendCanvasMentionImage([], canvas)!;
    const sameId = { ...conversation, id: "source" };
    expect(canvasMentionImageIndex(first.references, sameId)).toBe(-1);
    const second = appendCanvasMentionImage(first.references, sameId)!;
    expect(second.reference.id).toBe("conversation:source");
    expect(canvasMentionImageIndex(second.references, sameId)).toBe(1);
});

test("reused message IDs across sessions cannot replace an already attached different image", () => {
    const first = appendCanvasMentionImage([], conversation, 16, "owner-a:project:session-a")!;
    const other = { ...conversation, name: "另一个会话", storageKey: "image:other-session", dataUrl: "asset:other-session" };
    expect(canvasMentionImageIndex(first.references, other)).toBe(-1);
    const second = appendCanvasMentionImage(first.references, other, 16, "owner-a:project:session-b")!;
    expect(second.added).toBe(true);
    expect(second.reference.id).not.toBe(first.reference.id);
    expect(second.references.map(image => image.storageKey)).toEqual(["image:reply", "image:other-session"]);
    expect(appendCanvasMentionImage(second.references, other, 16, "owner-a:project:session-b")?.added).toBe(false);
});

test("node candidates use the current tray index and exclude fixed per-image task aliases", () => {
    const common = appendCanvasMentionImage([], conversation)!.reference;
    const task = { ...createImageReferenceItem({ id: "source", name: "原图", type: "image/png", dataUrl: "blob:source", storageKey: "image:source" }, "connection"), referenceKey: "node:source" };
    const inputs = [{ nodeId: common.id, type: "image" as const, title: common.name, image: common }];
    const candidates = configMentionInputs(inputs, [task, common], [canvas, conversation, { ...conversation, id: "other", storageKey: "image:other", dataUrl: "blob:other" }], { [common.id]: "图2" }, 1);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ mentionLabel: "图2", mentionSource: "conversation" });
    expect(candidates[1]).toMatchObject({ mentionLabel: "图3 · 添加", mentionImage: { id: "other" } });
});

const configNode = (prompt: string): CanvasNodeData => ({ id: "config", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 360, height: 480,
    metadata: { generationMode: "image", composerContent: prompt, manualImageReferences: [toCanvasStoredImageReference(appendCanvasMentionImage([], conversation)!.reference)] } });

test("manual-only conversation references enter actual context with the unchanged wire protocol", () => {
    const node = configNode("保留草稿，按 @[node:conversation:reply-image] 修改");
    const context = buildNodeGenerationContext(node.id, [node], [], node.metadata!.composerContent!, "image");
    expect(context.prompt).toBe("保留草稿，按 图片1 修改");
    expect(context.referenceImages).toHaveLength(1);
    expect(context.referenceImages[0]).toMatchObject({ id: "conversation:reply-image", storageKey: "image:reply" });
});

test("mixed manual/connected references follow tray reorder, not token encounter order", () => {
    const node = configNode("先参考 @[node:conversation:reply-image]，再参考 @[node:source] 和 @[node:node:source]");
    node.metadata!.imageReferenceOrder = ["node:source", "conversation:reply-image"];
    const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 256, height: 256, metadata: { content: "blob:source", storageKey: "image:source" } };
    const edges = [{ id: "edge", fromNodeId: source.id, toNodeId: node.id }];
    const context = buildNodeGenerationContext(node.id, [node, source], edges, node.metadata!.composerContent!, "image");
    expect(context.referenceImages.map(image => image.id)).toEqual(["source", "conversation:reply-image"]);
    expect(context.prompt).toBe("先参考 图片2，再参考 图片1 和 图片1");
    node.metadata!.imageReferenceOrder = ["conversation:reply-image", "node:source"];
    const reordered = buildNodeGenerationContext(node.id, [node, source], edges, node.metadata!.composerContent!, "image");
    expect(reordered.prompt).toBe("先参考 图片1，再参考 图片2 和 图片2");
    expect(reordered.referenceImages.map(image => image.id)).toEqual(["conversation:reply-image", "source"]);
});

test("attached images remain inputs without tokens; unresolved tokens fail before generation", () => {
    const node = configNode("请保留这段草稿");
    expect(buildNodeGenerationContext(node.id, [node], [], node.metadata!.composerContent!, "video").referenceImages).toHaveLength(1);
    node.metadata!.composerContent = "按 @[node:another-session-image] 修改";
    expect(() => buildNodeGenerationContext(node.id, [node], [], node.metadata!.composerContent!, "image")).toThrow("已失效引用");
    node.metadata!.composerContent = "按 @[node:conversation:reply-image] 修改";
    node.metadata!.manualImageReferences = [];
    expect(() => buildNodeGenerationContext(node.id, [node], [], node.metadata!.composerContent!, "image")).toThrow("已失效引用");
});

test("deduped stored aliases preserve connected graph tokens and copied configs keep conversation identity", () => {
    const node = configNode("按 @[node:source] 和 @[node:conversation:reply-image] 修改");
    const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "相同已存图片", position: { x: 0, y: 0 }, width: 256, height: 256, metadata: { content: "asset:reply", storageKey: "image:reply" } };
    const edges = [{ id: "edge", fromNodeId: source.id, toNodeId: node.id }];
    const context = buildNodeGenerationContext(node.id, [node, source], edges, node.metadata!.composerContent!, "image");
    expect(context.referenceImages).toHaveLength(1);
    expect(context.prompt).toBe("按 图片1 和 图片1 修改");
    const copy = cloneCanvasNodeGraph({ nodes: [node, source], connections: edges }, { x: 20, y: 20 });
    const copiedConfig = copy.nodes.find(item => item.type === CanvasNodeType.Config)!;
    const copiedContext = buildNodeGenerationContext(copiedConfig.id, copy.nodes, copy.connections, copiedConfig.metadata!.composerContent!, "image");
    expect(copiedContext.prompt).toBe(context.prompt);
    expect(copiedContext.referenceImages[0]?.id).toBe("conversation:reply-image");
    expect(node.metadata?.composerContent).toBe("按 @[node:source] 和 @[node:conversation:reply-image] 修改");
    node.metadata!.excludedConnectedImageReferenceKeys = ["node:source"];
    expect(() => buildNodeGenerationContext(node.id, [node, source], edges, node.metadata!.composerContent!, "image")).toThrow("已失效引用");
});

test("reselecting the current node or a shared stored image cannot duplicate references", () => {
    const first = appendCanvasMentionImage([], canvas)!;
    expect(canvasMentionImageIndex(first.references, canvas)).toBe(0);
    expect(appendCanvasMentionImage(first.references, canvas, 1)).toMatchObject({ index: 0, added: false });
    const alias = { ...conversation, storageKey: "image:source", dataUrl: undefined };
    expect(appendCanvasMentionImage(first.references, alias)!.references).toHaveLength(1);
});

test("unavailable, empty and excess images do not mutate the existing reference list", () => {
    const first = appendCanvasMentionImage([], canvas)!;
    expect(appendCanvasMentionImage(first.references, conversation, 1)).toBeNull();
    expect(appendCanvasMentionImage(first.references, { ...conversation, unavailableReason: "原件已丢失" })).toBeNull();
    expect(appendCanvasMentionImage(first.references, { ...conversation, dataUrl: undefined, storageKey: undefined })).toBeNull();
    expect(first.references).toHaveLength(1);
});
