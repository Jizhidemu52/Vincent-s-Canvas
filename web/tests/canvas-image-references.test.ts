import { expect, test } from "bun:test";

import { applyCanvasReferenceOrder, excludeConnectedReference, resolveCanvasImageReferences } from "../src/lib/canvas/canvas-image-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

const imageNode: CanvasNodeData = { id: "product", type: CanvasNodeType.Image, title: "产品", position: { x: 0, y: 0 }, width: 240, height: 240, metadata: { content: "https://images.test/product.png", storageKey: "image:product", mimeType: "image/png" } };
const configNode: CanvasNodeData = {
    id: "config", type: CanvasNodeType.Config, title: "生成", position: { x: 0, y: 0 }, width: 240, height: 180,
    metadata: {
        manualImageReferences: [{ referenceKey: "manual:logo", id: "logo", name: "logo.png", type: "image/png", content: "https://images.test/logo.png", storageKey: "image:logo", origin: "upload" }],
        imageReferenceOrder: ["manual:logo", "node:product"],
    },
};
const connection: CanvasConnection = { id: "link", fromNodeId: "product", toNodeId: "config" };

test("merges manual and connected images in the saved tray order", () => {
    expect(resolveCanvasImageReferences(configNode, [configNode, imageNode], [connection]).map((item) => item.referenceKey)).toEqual(["manual:logo", "node:product"]);
});

test("excludes a connected image without deleting its canvas connection", () => {
    const excluded = excludeConnectedReference(configNode.metadata!, "node:product");
    expect(resolveCanvasImageReferences({ ...configNode, metadata: excluded }, [configNode, imageNode], [connection])).toHaveLength(1);
});

test("restores saved order and appends newly connected images", () => {
    const current = resolveCanvasImageReferences(configNode, [configNode, imageNode], [connection]);
    expect(applyCanvasReferenceOrder([...current].reverse(), ["manual:logo", "node:product"]).map((item) => item.referenceKey)).toEqual(["manual:logo", "node:product"]);
});
