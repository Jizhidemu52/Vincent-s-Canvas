import { expect, test } from "bun:test";

import { buildNodeMentionReferencesByNodeId, mergeCanvasResourceReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
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
