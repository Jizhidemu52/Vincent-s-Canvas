import { expect, test } from "bun:test";

import { buildConfigGenerationInputsByNodeId, buildNodeGenerationInputs, createConfigGenerationInputIndex } from "@/components/canvas/canvas-node-generation";
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

test("indexes generation inputs for every config with the same connection ordering", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const text = node("text", CanvasNodeType.Text, "prompt");
    const configA = node("config-a", CanvasNodeType.Config);
    const configB = node("config-b", CanvasNodeType.Config);
    const nodes = [image, text, configA, configB];
    const connections = [connection("text-a", "text", "config-a"), connection("image-a", "image", "config-a")];

    const indexed = buildConfigGenerationInputsByNodeId(nodes, connections);

    expect(indexed.get(configA.id)).toEqual(buildNodeGenerationInputs(configA.id, nodes, connections));
    expect(indexed.get(configB.id)).toEqual([]);
});

test("lazily resolves and reuses only the requested config input list", () => {
    const image = node("image", CanvasNodeType.Image, "data:image/png;base64,one");
    const text = node("text", CanvasNodeType.Text, "prompt");
    const config = node("config", CanvasNodeType.Config);
    const index = createConfigGenerationInputIndex([image, text, config], [connection("text-config", "text", "config"), connection("image-config", "image", "config")]);

    const first = index.get(config.id);
    expect(first.map((input) => input.nodeId)).toEqual(["text", "image"]);
    expect(index.get(config.id)).toBe(first);
    expect(index.get(image.id)).toEqual([]);
});

test("reads updated config input content from a stable node map", () => {
    const text = node("text", CanvasNodeType.Text, "first draft");
    const config = node("config", CanvasNodeType.Config);
    const map = createCanvasNodeMap([text, config]);
    const index = createConfigGenerationInputIndex([text, config], [connection("text-config", "text", "config")], map);
    const updatedText = { ...text, metadata: { content: "latest draft" } };

    expect(refreshCanvasNodeMap(map, [updatedText, config])).toBe(map);
    expect(index.get(config.id)[0]?.text).toBe("latest draft");
});
