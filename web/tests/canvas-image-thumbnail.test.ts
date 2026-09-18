import { expect, test } from "bun:test";
import { canvasImagePreviewEdge, imageThumbnailSize } from "@/lib/canvas/canvas-image-thumbnail";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 400, height: 300, metadata: { storageKey: "image:original", content: "blob:original", naturalWidth: 4000, naturalHeight: 3000 } };

test("canvas thumbnail tier follows displayed dimensions, zoom and DPR", () => {
    expect(canvasImagePreviewEdge(node, 0.5, 1)).toBe(256);
    expect(canvasImagePreviewEdge(node, 1, 1)).toBe(512);
    expect(canvasImagePreviewEdge(node, 1, 2)).toBe(1024);
    expect(canvasImagePreviewEdge(node, 3, 1)).toBe(0);
    expect(canvasImagePreviewEdge({ ...node, width: 200, height: 150 }, 1, 1)).toBe(256);
});

test("small images, near-native views, unavailable metadata and non-images keep originals", () => {
    const small = { ...node, metadata: { ...node.metadata, naturalWidth: 200, naturalHeight: 150 } };
    expect(canvasImagePreviewEdge(small, 0.1, 1)).toBe(0);
    const near = { ...node, metadata: { ...node.metadata, naturalWidth: 1000, naturalHeight: 750 } };
    expect(canvasImagePreviewEdge(near, 1.875, 1)).toBe(0);
    expect(canvasImagePreviewEdge({ ...node, metadata: { content: "https://example.com/image.png" } }, 0.5)).toBe(0);
    expect(canvasImagePreviewEdge({ ...node, type: CanvasNodeType.Video }, 0.5)).toBe(0);
    expect(canvasImagePreviewEdge(node, Number.NaN)).toBe(0);
});

test("contain and free-resize choose enough pixels without distorting or upscaling cached images", () => {
    const tallBox = { ...node, width: 200, height: 1200 };
    expect(canvasImagePreviewEdge(tallBox, 1)).toBe(256);
    expect(canvasImagePreviewEdge({ ...tallBox, metadata: { ...node.metadata, freeResize: true } }, 1)).toBe(0);
    expect(imageThumbnailSize(4000, 3000, 512)).toEqual({ width: 512, height: 384 });
    expect(imageThumbnailSize(120, 80, 256)).toEqual({ width: 120, height: 80 });
});
