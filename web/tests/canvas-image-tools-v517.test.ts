import { expect, test } from "bun:test";
import { checkEditedImageBlob, editedCanvasMimeType } from "../src/lib/canvas/canvas-edited-image-format";
import { cropFromPixels, cropPixels, newCrop, resizeCrop } from "../src/lib/canvas/canvas-crop-geometry";
import { createCanvasImageEditVersion } from "../src/lib/canvas/canvas-image-edit";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { createCanvasImageOperationRunner } from "../src/lib/canvas/canvas-image-operation";

test("opaque JPEG outputs stay JPEG but any alpha and all lossless sources stay PNG", () => {
    let alpha = 255; const chunks: number[] = [];
    const canvas = { width: 1000, height: 150, getContext: () => ({ getImageData: (_x: number, y: number, _w: number, h: number) => { chunks.push(h); return { data: new Uint8ClampedArray([21, 19, 20, y >= 64 ? alpha : 255]) }; } }) } as unknown as HTMLCanvasElement;
    expect(editedCanvasMimeType(canvas, "image/jpeg")).toBe("image/jpeg");
    expect(chunks).toEqual([64, 64, 22]);
    alpha = 254;
    expect(editedCanvasMimeType(canvas, "image/jpeg")).toBe("image/png");
    expect(editedCanvasMimeType(canvas, "image/png")).toBe("image/png");
    expect(() => checkEditedImageBlob(new Blob())).toThrow("编码失败");
    expect(() => checkEditedImageBlob({ size: 20 * 1024 * 1024 + 1 } as Blob)).toThrow("20 MB");
});

test("crop supports exact single-pixel selections, bounds precise input, and draws a new reverse selection", () => {
    const image = { width: 4033, height: 2161 };
    const pixel = { x: 51, y: 73, width: 1, height: 1 };
    expect(cropPixels(cropFromPixels(pixel, image), image)).toEqual(pixel);
    expect(cropPixels(cropFromPixels({ x: 4030, y: 2160, width: 100, height: 40 }, image), image)).toEqual({ x: 4030, y: 2160, width: 3, height: 1 });
    const resized = resizeCrop({ x: 0, y: 0, width: .5, height: .5 }, -.9, -.9, "se", null, image);
    expect(cropPixels(resized, image)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(cropPixels(newCrop({ x: .8, y: .8 }, { x: .1, y: .2 }, { width: 1000, height: 1000 }, null), { width: 1000, height: 1000 })).toEqual({ x: 100, y: 200, width: 700, height: 600 });
});

test("manual editor saves a distinct version without copying task or batch bindings over its original", () => {
    const original: CanvasNodeData = { id: "a", type: CanvasNodeType.Image, title: "样衣", position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { storageKey: "image:old", content: "blob:old", imageName: "款式A", imageVersion: 3, isBatchRoot: true, primaryImageId: "child" } };
    const before = structuredClone(original);
    const child = createCanvasImageEditVersion([original], original, { storageKey: "image:new", url: "blob:new", width: 1000, height: 500, mimeType: "image/jpeg", bytes: 10000 }, "b", { x: 500, y: 0 });
    expect(original).toEqual(before);
    expect(child).toMatchObject({ id: "b", title: "样衣_编辑", position: { x: 500, y: 0 }, metadata: { imageName: "款式A_编辑", imageVersion: 4, storageKey: "image:new", compareSources: [{ storageKey: "image:old" }] } });
    expect(child.metadata?.isBatchRoot).toBeUndefined();
    expect(() => createCanvasImageEditVersion([], original, {} as never, "b", { x: 0, y: 0 })).toThrow("移除");
});

test("canceling a local operation by key leaves another operation running", async () => {
    const runner = createCanvasImageOperationRunner();
    let release!: () => void; let errorCount = 0;
    const feedback = { start() {}, finish() {}, error() { errorCount++; } };
    const first = runner.run("first", () => new Promise<void>(() => {}), feedback);
    const second = runner.run("second", () => new Promise<void>(resolve => { release = resolve; }), feedback);
    await Promise.resolve(); runner.cancel("first"); release();
    expect(await first).toBe(false); expect(await second).toBe(true); expect(errorCount).toBe(0);
});
