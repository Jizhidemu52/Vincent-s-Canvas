import { expect, test } from "bun:test";

import { buildConfigGenerationInputsByNodeId, buildNodeGenerationInputs } from "@/components/canvas/canvas-node-generation";
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
