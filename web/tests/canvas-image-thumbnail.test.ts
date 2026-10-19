import { expect, test } from "bun:test";
import { canvasImagePreviewEdge, canvasPreviewScaleBucket, canvasServerThumbnailUrl, imageThumbnailSize } from "@/lib/canvas/canvas-image-thumbnail";
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

test("zoom changes inside the same preview tier do not request another raster", () => {
    expect([0.12, 0.25, 0.49, 0.5].map(canvasPreviewScaleBucket)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect([0.51, 0.8, 1].map(canvasPreviewScaleBucket)).toEqual([1, 1, 1]);
    expect([1.01, 1.4, 2].map(canvasPreviewScaleBucket)).toEqual([2, 2, 2]);
    expect(canvasImagePreviewEdge(node, 0.51)).toBe(canvasImagePreviewEdge(node, 0.99));
});

test("cloud image previews use authenticated thumbnails without changing original content", () => {
    const content = "/api/assets/11111111-2222-4333-8444-555555555555/content";
    const cloud = { ...node, metadata: { ...node.metadata, storageKey: undefined, content } };
    expect(canvasImagePreviewEdge(cloud, 0.5)).toBe(256);
    expect(canvasServerThumbnailUrl(content, 256)).toBe(content.replace("/content", "/thumb?w=256"));
    expect(canvasServerThumbnailUrl(content, 512)).toBe(content.replace("/content", "/thumb?w=1024"));
    expect(canvasServerThumbnailUrl(content, 0)).toBeNull();
    expect(canvasServerThumbnailUrl("https://external.example/image.png", 256)).toBeNull();
    expect(cloud.metadata.content).toBe(content);
});
