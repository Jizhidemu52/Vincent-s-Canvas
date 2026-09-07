import { expect, test } from "bun:test";
import { applyCanvasImageEdit, rollbackCanvasImageEdit } from "@/lib/canvas/canvas-image-edit";
import { editorDocumentSize, editorPoint, editorRect } from "@/lib/canvas/image-editor-document";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = { id: "original", type: CanvasNodeType.Image, title: "原图", position: { x: 20, y: 40 }, width: 300, height: 200, metadata: { content: "blob:original", storageKey: "image:original", prompt: "Original prompt", naturalWidth: 900, naturalHeight: 600, originalFileName: "shirt.jpg" } };
const image = { url: "blob:edited", storageKey: "image:edited", width: 600, height: 600, bytes: 2048, mimeType: "image/png" };

test("manual edit replaces the selected node in place and preserves its provenance and references", () => {
    const other = { ...node, id: "other" };
    const result = applyCanvasImageEdit([node, other], node, image);
    expect(result[0]).toMatchObject({ id: node.id, position: node.position, width: 300, height: 300, metadata: { content: image.url, storageKey: image.storageKey, prompt: "Original prompt", originalFileName: "shirt.png", naturalWidth: 600, naturalHeight: 600 } });
    expect(result[1]).toBe(other);
    expect(node.metadata?.storageKey).toBe("image:original");
    const context = buildNodeGenerationContext("other", result, [{ id: "link", fromNodeId: "original", toNodeId: "other" }], "继续 AI 编辑");
    expect(context.referenceImages.some(reference => reference.storageKey === image.storageKey)).toBe(true);
    expect(context.referenceImages.some(reference => reference.storageKey === "image:original")).toBe(false);
    expect(applyCanvasImageEdit(result, node, image)).toBe(result);
});

test("editing either a batch cover or its primary child keeps both images synchronized", () => {
    const primary = { ...node, id: "primary", metadata: { ...node.metadata, batchRootId: "original" } };
    const root = { ...node, metadata: { ...node.metadata, isBatchRoot: true, primaryImageId: "primary", batchChildIds: ["primary"] } };
    for (const target of [root, primary]) {
        const result = applyCanvasImageEdit([root, primary], target, image);
        expect(result.map(item => item.metadata?.storageKey)).toEqual([image.storageKey, image.storageKey]);
        expect(result[0].metadata?.batchChildIds).toEqual(["primary"]);
    }
});

test("missing or concurrently replaced images cannot be overwritten by a late editor save", () => {
    expect(() => applyCanvasImageEdit([], node, image)).toThrow("已被移除");
    expect(() => applyCanvasImageEdit([{ ...node, metadata: { ...node.metadata, content: "blob:new" } }], node, image)).toThrow("已发生变化");
});

test("a failed write restores only this edit, retaining unrelated changes", () => {
    const updated = applyCanvasImageEdit([node], node, image);
    const unrelated = { ...node, id: "new-node" };
    expect(rollbackCanvasImageEdit([...updated, unrelated], [node], image.storageKey)).toEqual([node, unrelated]);
});

test("selection coordinates account for zoom, reverse dragging and image edges", () => {
    expect(editorPoint({ x: 60, y: 45 }, { x: 10, y: 20, width: 100, height: 50 }, { width: 800, height: 400 })).toEqual({ x: 400, y: 200 });
    expect(editorRect({ x: 790, y: 390 }, { x: -20, y: -10 }, { width: 800, height: 400 })).toEqual({ x: 0, y: 0, width: 790, height: 390 });
    expect(editorRect({ x: 800, y: 400 }, { x: 800, y: 400 }, { width: 800, height: 400 })).toEqual({ x: 799, y: 399, width: 1, height: 1 });
    expect(editorDocumentSize({ width: 800, height: 400 }, [{ kind: "crop", rect: { x: 10, y: 10, width: 200, height: 100 } }, { kind: "rotate" }])).toEqual({ width: 100, height: 200 });
});
