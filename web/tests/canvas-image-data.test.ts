import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cropDataUrl, cropImageBlob, splitDataUrl, splitImageBlobs, upscaleDataUrl, upscaleImageBlob, type ImageUpscaleAlgorithm } from "@/lib/canvas/canvas-image-data";

const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let imageMode: "load" | "error" | "hang" = "load";
let encodeMode: "success" | "null" | "throw" | "hang" = "success";
let sourceSize = { width: 4033, height: 2161 };
let contextAvailable = true;
let dataUrlCalls = 0;
let failedDrawAt = 0;
const images: FakeImage[] = [];
const canvases: FakeCanvas[] = [];
class FakeImage {
    width = sourceSize.width;
    height = sourceSize.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    currentSrc = "";
    constructor() { images.push(this); }
    get src() { return this.currentSrc; }
    set src(value: string) {
        this.currentSrc = value;
        if (!value) return;
        queueMicrotask(() => {
            if (imageMode === "load") this.onload?.();
            else if (imageMode === "error") this.onerror?.();
        });
    }
}
class FakeCanvas {
    width = 0;
    height = 0;
    draw: number[] = [];
    context = {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        drawImage: (_source: unknown, ...args: number[]) => { if (failedDrawAt && canvases.length === failedDrawAt) throw new Error("draw failed"); this.draw = args; },
    };
    constructor() { canvases.push(this); }
    getContext() { return contextAvailable ? this.context : null; }
    snapshot() { return { width: this.width, height: this.height, draw: this.draw, smoothing: this.context.imageSmoothingEnabled, quality: this.context.imageSmoothingQuality }; }
    toDataURL(type: string) {
        dataUrlCalls++;
        expect(type).toBe("image/png");
        return `data:image/png;base64,${btoa(JSON.stringify(this.snapshot()))}`;
    }
    toBlob(callback: (blob: Blob | null) => void, type: string) {
        expect(type).toBe("image/png");
        if (encodeMode === "throw") throw new DOMException("tainted canvas", "SecurityError");
        if (encodeMode === "hang") return;
        const snapshot = this.snapshot();
        queueMicrotask(() => callback(encodeMode === "null" ? null : new Blob([JSON.stringify(snapshot)], { type })));
    }
}
beforeEach(() => {
    imageMode = "load"; encodeMode = "success"; contextAvailable = true;
    sourceSize = { width: 4033, height: 2161 }; dataUrlCalls = 0; failedDrawAt = 0;
    images.length = 0; canvases.length = 0;
    Object.defineProperty(globalThis, "Image", { configurable: true, value: FakeImage });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag: string) => { expect(tag).toBe("canvas"); return new FakeCanvas(); } } });
});
afterEach(() => {
    if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
    else Reflect.deleteProperty(globalThis, "Image");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
});
const unpackDataUrl = (url: string) => JSON.parse(atob(url.split(",")[1]!));
const unpackBlob = async (blob: Blob) => JSON.parse(await blob.text());
const allReleased = () => expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);

describe("image binary output contracts", () => {
    test("crop Blob preserves old exact rectangle rounding without base64 encoding", async () => {
        const crop = { x: .12, y: .07, width: .67, height: .83 };
        const blob = await cropImageBlob("blob:original", crop);
        expect(dataUrlCalls).toBe(0);
        expect(blob.type).toBe("image/png");
        const actual = await unpackBlob(blob);
        expect(actual).toEqual(unpackDataUrl(await cropDataUrl("blob:original", crop)));
        expect(actual).toMatchObject({ width: Math.ceil(4033 * .67), height: Math.ceil(2161 * .83), draw: [Math.floor(4033 * .12), Math.floor(2161 * .07), Math.ceil(4033 * .67), Math.ceil(2161 * .83), 0, 0, Math.ceil(4033 * .67), Math.ceil(2161 * .83)] });
        allReleased();
    });
    test("center crop keeps its original square geometry", async () => {
        expect(await unpackBlob(await cropImageBlob("blob:original"))).toMatchObject({ width: 2161, height: 2161, draw: [936, 0, 2161, 2161, 0, 0, 2161, 2161] });
        allReleased();
    });
    test("uneven split dimensions cover original pixels and retain row-major order", async () => {
        const pieces = await splitImageBlobs("blob:original", { rows: 3, columns: 4 });
        expect(dataUrlCalls).toBe(0);
        const legacy = await splitDataUrl("blob:original", { rows: 3, columns: 4 });
        let area = 0;
        for (let index = 0; index < pieces.length; index++) {
            const piece = pieces[index]!;
            const geometry = await unpackBlob(piece.blob);
            expect([piece.row, piece.column]).toEqual([Math.floor(index / 4), index % 4]);
            expect(geometry).toEqual(unpackDataUrl(legacy[index]!.dataUrl));
            expect(geometry.width).toBe(geometry.draw[2]);
            expect(geometry.height).toBe(geometry.draw[3]);
            area += geometry.width * geometry.height;
        }
        expect(area).toBe(4033 * 2161);
        allReleased();
    });
    test("a grid finer than the original pixels cannot create blank output pieces", async () => {
        sourceSize = { width: 1, height: 1 };
        await expect(splitImageBlobs("blob:tiny-original", { rows: 2, columns: 2 })).rejects.toThrow("原图像素");
        expect(canvases).toHaveLength(0);
        sourceSize = { width: 3, height: 2 };
        await expect(splitDataUrl("blob:tiny-original", { rows: 3, columns: 3 })).rejects.toThrow("原图像素");
        expect(canvases).toHaveLength(0);
        const pieces = await splitImageBlobs("blob:tiny-original", { rows: 2, columns: 3 });
        expect(pieces).toHaveLength(6);
        expect(await unpackBlob(pieces[5]!.blob)).toMatchObject({ width: 1, height: 1, draw: [2, 1, 1, 1, 0, 0, 1, 1] });
        allReleased();
    });
    for (const algorithm of ["nearest", "bilinear", "high"] as ImageUpscaleAlgorithm[]) {
        test(`4K ${algorithm} resize retains aspect, sampling flags, and legacy draw operations`, async () => {
            sourceSize = { width: 333, height: 271 };
            const params = { targetLongEdge: 4096, algorithm };
            const blob = await upscaleImageBlob("blob:original", params);
            expect(dataUrlCalls).toBe(0);
            const binaryDraws = canvases.map(canvas => canvas.draw);
            allReleased();
            canvases.length = 0;
            const legacy = await upscaleDataUrl("blob:original", params);
            expect(await unpackBlob(blob)).toEqual(unpackDataUrl(legacy));
            expect(canvases.map(canvas => canvas.draw)).toEqual(binaryDraws);
            expect(await unpackBlob(blob)).toMatchObject({ width: 4096, height: Math.round(271 * 4096 / 333), smoothing: algorithm !== "nearest", quality: algorithm === "bilinear" ? "medium" : "high" });
            allReleased();
        });
    }
});

describe("image failures and cancellation", () => {
    test("bad source rejects every edit entry point and releases event handlers", async () => {
        imageMode = "error";
        for (const run of [() => cropImageBlob("broken"), () => splitImageBlobs("broken", { rows: 2, columns: 2 }), () => upscaleImageBlob("broken", { targetLongEdge: 4096, algorithm: "high" }), () => cropDataUrl("broken")]) {
            await expect(run()).rejects.toThrow("无法读取图片");
        }
        expect(images.every(image => !image.onload && !image.onerror && image.src === "")).toBe(true);
        expect(canvases).toHaveLength(0);
    });
    test("missing image load event times out instead of remaining busy forever", async () => {
        imageMode = "hang";
        await expect(cropImageBlob("hung", undefined, { timeoutMs: 5 })).rejects.toThrow("图片读取超时");
        expect(images[0]!.onload).toBeNull();
        expect(images[0]!.src).toBe("");
    });
    test("aborting an image load rejects immediately and cannot create a late canvas", async () => {
        imageMode = "hang";
        const controller = new AbortController();
        const pending = cropImageBlob("hung", undefined, { signal: controller.signal });
        const rejected = pending.catch(error => error);
        const lateLoad = images[0]!.onload;
        controller.abort();
        expect(await rejected).toMatchObject({ name: "AbortError" });
        lateLoad?.();
        expect(canvases).toHaveLength(0);
    });
    test("already cancelled operation never assigns original source", async () => {
        const controller = new AbortController(); controller.abort();
        await expect(upscaleImageBlob("blob:original", { targetLongEdge: 4096, algorithm: "nearest" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(images[0]!.src).toBe("");
        expect(canvases).toHaveLength(0);
    });
    test("a missing context rejects instead of returning the unedited source", async () => {
        contextAvailable = false;
        await expect(cropImageBlob("blob:original")).rejects.toThrow("无法创建图片处理画布");
        allReleased();
    });
    test("drawing failure releases the new and previous high-quality upscale buffers", async () => {
        sourceSize = { width: 100, height: 80 }; failedDrawAt = 3;
        await expect(upscaleImageBlob("blob:original", { targetLongEdge: 4096, algorithm: "high" })).rejects.toThrow("draw failed");
        expect(canvases).toHaveLength(3);
        allReleased();
    });
    test("empty/throwing/timed out encoders all reject and release large canvases", async () => {
        for (const mode of ["null", "throw", "hang"] as const) {
            encodeMode = mode;
            await expect(cropImageBlob("blob:original", undefined, { timeoutMs: 5 })).rejects.toBeInstanceOf(Error);
            allReleased();
        }
    });
    test("aborting encoding releases its backing canvas", async () => {
        encodeMode = "hang";
        const controller = new AbortController();
        const pending = splitImageBlobs("blob:original", { rows: 12, columns: 12 }, { signal: controller.signal });
        const rejected = pending.catch(error => error);
        await new Promise(resolve => setTimeout(resolve, 0));
        controller.abort();
        expect(await rejected).toMatchObject({ name: "AbortError" });
        expect(canvases).toHaveLength(1);
        allReleased();
    });
});
