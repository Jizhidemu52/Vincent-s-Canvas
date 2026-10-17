import { expect, test } from "bun:test";

import { applyCanvasReferenceOrder, excludeConnectedReference, resolveCanvasImageReferences, resolveCanvasNodeImageReferences } from "../src/lib/canvas/canvas-image-references";
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

test("an edited node remains first even when saved auxiliary order includes or duplicates it", () => {
    const target: CanvasNodeData = { ...imageNode, metadata: { ...imageNode.metadata,
        manualImageReferences: [
            ...configNode.metadata!.manualImageReferences!,
            { referenceKey: "upload:copy", id: "copy", name: "重复原图", type: "image/png", content: "https://images.test/alias.png", storageKey: "image:product", origin: "upload" },
            { referenceKey: "canvas:product", id: "product", name: "自己", type: "image/png", content: "data:image/png;base64,other", origin: "canvas" },
        ], imageReferenceOrder: ["manual:logo", "source:product", "upload:copy"],
    } };
    expect(resolveCanvasNodeImageReferences(target, [target], []).map(item => [item.id, item.dataUrl])).toEqual([
        ["product", "https://images.test/product.png"], ["logo", "https://images.test/logo.png"],
    ]);
    const dataUrlNode = { ...target, metadata: { ...target.metadata, storageKey: undefined, content: "data:image/png;base64,ORIGINAL", manualImageReferences: [
        { referenceKey: "upload:copy", id: "copy", name: "重复原图", type: "image/png", content: "data:image/png;base64,ORIGINAL", origin: "upload" as const },
    ] } };
    expect(resolveCanvasNodeImageReferences(dataUrlNode, [dataUrlNode], []).map(item => item.id)).toEqual(["product"]);
});

test("config nodes and empty image nodes retain their auxiliary ordering without a synthetic original", () => {
    expect(resolveCanvasNodeImageReferences(configNode, [configNode, imageNode], [connection]).map(item => item.id)).toEqual(["logo", "product"]);
    const empty = { ...imageNode, metadata: { manualImageReferences: configNode.metadata!.manualImageReferences } };
    expect(resolveCanvasNodeImageReferences(empty, [empty], []).map(item => item.id)).toEqual(["logo"]);
});

test("retains ordered storage-only public images and applies their exclusion keys", () => {
    const stored = { ...imageNode, metadata: { storageKey: "image:product", content: "", mimeType: "image/webp" } };
    const references = resolveCanvasImageReferences(configNode, [configNode, stored], [connection]);
    expect(references.map(reference => reference.id)).toEqual(["logo", "product"]);
    expect(references[1]).toMatchObject({ storageKey: "image:product", dataUrl: "", type: "image/webp" });
    const excluded = { ...configNode, metadata: excludeConnectedReference(configNode.metadata!, "node:product") };
    expect(resolveCanvasImageReferences(excluded, [excluded, stored], [connection]).map(reference => reference.id)).toEqual(["logo"]);
});

test("keeps distinct storage-only original and auxiliary images instead of treating empty URLs as duplicates", () => {
    const original = { ...imageNode, metadata: { storageKey: "image:product", content: "" } };
    const auxiliary = { ...imageNode, id: "auxiliary", metadata: { storageKey: "image:auxiliary", content: "" } };
    const references = resolveCanvasNodeImageReferences(original, [original, auxiliary], [{ id: "aux-source", fromNodeId: "auxiliary", toNodeId: original.id }]);
    expect(references.map(reference => [reference.id, reference.dataUrl, reference.storageKey])).toEqual([
        ["product", "", "image:product"], ["auxiliary", "", "image:auxiliary"],
    ]);
});
