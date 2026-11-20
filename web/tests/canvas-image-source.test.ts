import { expect, test } from "bun:test";
import { canvasImageSource, hasCanvasImageSource, serverAssetContentUrl } from "@/lib/canvas/canvas-image-source";

const assetId = "b3000000-0000-4000-8000-000000000001";
const cloud = `/api/assets/${assetId}/content`;

test("cloud-only and stale browser sources resolve to the durable original without mutating metadata", () => {
    for (const content of [undefined, "", "blob:http://localhost/expired", cloud]) {
        const metadata = { content, serverAssetId: assetId, storageKey: "image:original" };
        const before = structuredClone(metadata);
        expect(canvasImageSource(metadata)).toBe(cloud);
        expect(hasCanvasImageSource(metadata)).toBe(true);
        expect(metadata).toEqual(before);
    }
});

test("local and storage-only sources keep their existing resolution contract", () => {
    expect(canvasImageSource({ content: "blob:local", storageKey: "image:local" })).toBe("blob:local");
    expect(canvasImageSource({ storageKey: "image:local" })).toBe("");
    expect(hasCanvasImageSource({ storageKey: "image:local" })).toBe(true);
    expect(hasCanvasImageSource()).toBe(false);
    expect(canvasImageSource()).toBe("");
    expect(serverAssetContentUrl(" ")).toBe("");
    expect(serverAssetContentUrl(" ../outside ")).toBe("/api/assets/..%2Foutside/content");
});
