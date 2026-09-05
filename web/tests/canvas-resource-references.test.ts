import { expect, test } from "bun:test";

import { buildNodeMentionReferencesByNodeId, createCanvasMentionReferenceIndex, createCanvasResourceReferenceIndex, mergeCanvasResourceReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { createCanvasNodeMap, refreshCanvasNodeMap } from "@/lib/canvas/canvas-node-map";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, type: CanvasNodeType, content?: string): CanvasNodeData => ({
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: content ? { content } : undefined,
});

const connection = (id: string, fromNodeId: string, toNodeId: string): CanvasConnection => ({ id, fromNodeId, toNodeId });

test("builds every node mention list from a single connection index", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const text = node("text", CanvasNodeType.Text, "prompt");
    const config = node("config", CanvasNodeType.Config);
    const audio = node("audio", CanvasNodeType.Audio, "data:audio/wav;base64,two");
    const references = buildNodeMentionReferencesByNodeId([image, text, config, audio], [connection("image-config", "image", "config"), connection("text-config", "text", "config")]);

    expect(references.get("config")?.map((reference) => reference.nodeId)).toEqual(["image", "text"]);
    expect(references.get("image")?.map((reference) => reference.nodeId)).toEqual(["text"]);
    expect(references.get("audio")?.map((reference) => reference.nodeId)).toEqual(["audio"]);
});

test("lazily creates and reuses only the requested node mention list", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const text = node("text", CanvasNodeType.Text, "prompt");
    const config = node("config", CanvasNodeType.Config);
    const index = createCanvasMentionReferenceIndex([image, text, config], [connection("image-config", "image", "config"), connection("text-config", "text", "config")]);

    const first = index.get("image");
    expect(first.map((reference) => reference.nodeId)).toEqual(["text"]);
    expect(index.get("image")).toBe(first);
    expect(index.get("config").map((reference) => reference.nodeId)).toEqual(["image", "text"]);
});

test("lazily resolves global resource labels while retaining document order", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const text = node("text", CanvasNodeType.Text, "prompt");
    const secondImage = node("second-image", CanvasNodeType.Image, "data:image/png;base64,two");
    const index = createCanvasResourceReferenceIndex([image, text, secondImage]);

    const first = index.get("image");
    expect(first).toMatchObject({ nodeId: "image", label: "图片1", active: false });
    expect(index.get("image")).toBe(first);
    expect(index.get("second-image")).toMatchObject({ nodeId: "second-image", label: "图片2", active: false });
    expect(index.get("missing")).toBeUndefined();
});

test("reads current resource content from a stable node map without rebuilding relationship indexes", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const originalText = node("text", CanvasNodeType.Text, "first draft");
    const config = node("config", CanvasNodeType.Config);
    const map = createCanvasNodeMap([image, originalText, config]);
    const connections = [connection("image-config", "image", "config"), connection("text-config", "text", "config")];
    const mentionIndex = createCanvasMentionReferenceIndex([image, originalText, config], connections, map);
    const resourceIndex = createCanvasResourceReferenceIndex([image, originalText, config], map);
    const updatedText = { ...originalText, metadata: { content: "latest draft" } };

    expect(refreshCanvasNodeMap(map, [image, updatedText, config])).toBe(map);
    expect(mentionIndex.get("config").find((reference) => reference.nodeId === "text")?.text).toBe("latest draft");
    expect(resourceIndex.get("text")?.text).toBe("latest draft");
});

test("keeps global resource order while applying the active node references", () => {
    const globalReferences: CanvasResourceReference[] = [
        { id: "image", nodeId: "image", kind: "image", label: "图片1", title: "image", active: false },
        { id: "text", nodeId: "text", kind: "text", label: "文本1", title: "text", active: false },
    ];
    const activeReferences: CanvasResourceReference[] = [{ ...globalReferences[1], active: true }];

    expect(mergeCanvasResourceReferences(globalReferences, activeReferences)).toEqual([
        { id: "image", nodeId: "image", kind: "image", label: "图片1", title: "image", active: false },
        { id: "text", nodeId: "text", kind: "text", label: "文本1", title: "text", active: true },
    ]);
});
