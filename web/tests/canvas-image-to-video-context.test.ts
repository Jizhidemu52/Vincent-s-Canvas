import { expect, test } from "bun:test";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const image = (id: string, storageOnly = false): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 512, height: 512,
    metadata: { ...(storageOnly ? {} : { content: `data:image/png;base64,${id}` }), storageKey: `image:${id}`, mimeType: "image/png", naturalWidth: 512, naturalHeight: 512 } });

test.each([false, true])("video from an unconnected image retains its original first frame (storage-only=%s)", storageOnly => {
    const source = image("source", storageOnly);
    const context = buildNodeGenerationContext("source", [source], [], "move", "video");
    expect(context.imageCount).toBe(1);
    expect(context.referenceImages[0]).toMatchObject({ id: "source", storageKey: "image:source", dataUrl: storageOnly ? "" : "data:image/png;base64,source" });
});

test("original first frame precedes connected references without changing non-video input semantics", () => {
    const nodes = [image("source"), image("other")], edges = [{ id: "reference", fromNodeId: "other", toNodeId: "source" }];
    expect(buildNodeGenerationContext("source", nodes, edges, "move", "video").referenceImages.map(image => image.id)).toEqual(["source", "other"]);
    expect(buildNodeGenerationContext("source", nodes, edges, "edit", "image").referenceImages.map(image => image.id)).toEqual(["other"]);
    expect(buildNodeGenerationContext("source", nodes, [], "describe", "text").referenceImages).toEqual([]);
});
