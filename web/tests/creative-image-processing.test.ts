import { describe, expect, test } from "bun:test";
import { compositeSelectedPixels, hexRgb, lineArtPixels, preferredSelectionSize, recolorPixels, requireMatchingAspect, selectionHasPixels, selectionSizeMatches, suggestPalette, type PixelImage } from "@/pages/creative/image-processing";
import { traceLineArt } from "@/pages/creative/line-trace";
import { selectionMatchesSource, serializeSceneDraft, serializeSceneLog, type SceneImage, type SceneLog } from "@/pages/creative/use-scene-workspace";
import { createSceneForm } from "@/pages/creative/scene-form-model";

const pixels = (...values: number[][]): PixelImage => ({ width: values.length, height: 1, data: new Uint8ClampedArray(values.flat()) });
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], green = [0, 255, 0, 255];
describe("bounded local image processing", () => {
    test("outside-selection RGBA is unchanged and full coverage selects the generated pixel", () => {
        const original = pixels(red, [12, 56, 78, 125], [90, 12, 43, 0]);
        const result = compositeSelectedPixels(original, pixels(blue, green, green), pixels([0, 0, 0, 255], [255, 255, 255, 0], [0, 0, 0, 0]));
        expect(Array.from(result.data)).toEqual([...blue, 12, 56, 78, 125, 90, 12, 43, 0]);
        expect(Array.from(original.data.slice(0, 4))).toEqual(red);
    });
    test("soft boundary blends and transparent generated pixels do not erase the original", () => {
        const result = compositeSelectedPixels(pixels(red, red), pixels(blue, [0, 255, 0, 0]), pixels([0, 0, 0, 128], [0, 0, 0, 255]));
        expect(Array.from(result.data)).toEqual([127, 0, 128, 255, ...red]);
    });
    test("selection rejects mismatched dimensions, empty data and wrong aspect", () => {
        expect(() => compositeSelectedPixels(pixels(red), pixels(red, red), pixels(red))).toThrow("尺寸");
        expect(selectionHasPixels(pixels([255, 255, 255, 0]))).toBe(false);
        expect(selectionHasPixels(pixels([0, 0, 0, 1]))).toBe(true);
        expect(() => requireMatchingAspect({ width: 100, height: 200 }, { width: 512, height: 1024 })).not.toThrow();
        expect(() => requireMatchingAspect({ width: 100, height: 200 }, { width: 1024, height: 1024 })).toThrow("未进行选区合成");
    });
    test("selection chooses a matching output size and incompatible settings are rejected before generation", () => {
        const source = { width: 1800, height: 1200 };
        expect(preferredSelectionSize(source, ["1024x1024", "1536x1024", "auto"])).toBe("1536x1024");
        expect(preferredSelectionSize(source, ["1:1", "3:2", "auto"])).toBe("3:2");
        expect(preferredSelectionSize({ width: 1333, height: 2000 }, ["1024x1024", "auto"])).toBe("auto");
        expect(selectionSizeMatches("1024x1024", source)).toBe(false);
        expect(selectionSizeMatches("3:2", source)).toBe(true);
        expect(selectionSizeMatches("auto", source)).toBe(true);
    });
    test("color mappings never cascade and preserve alpha, geometry and unmatched colors", () => {
        const source = pixels(red, blue, [255, 0, 0, 127], [255, 0, 0, 0], green);
        const result = recolorPixels(source, [{ from: "#FF0000", to: "#0000FF" }, { from: "#0000FF", to: "#00FF00" }], 0);
        expect(Array.from(result.data)).toEqual([...blue, ...green, 0, 0, 255, 127, 255, 0, 0, 0, ...green]);
        expect(result.changedPixels).toBe(3); expect(result.matchedPixels).toBe(3);
        expect(result.width).toBe(5); expect(Array.from(source.data.slice(0, 4))).toEqual(red);
    });
    test("nearest original color wins, tolerance is bounded and HEX is validated", () => {
        expect(recolorPixels(pixels([250, 0, 0, 255]), [{ from: "#FF0000", to: "#FF0000" }], 20).changedPixels).toBe(0);
        expect(Array.from(recolorPixels(pixels([250, 0, 0, 255]), [{ from: "#FF0000", to: "#0000FF" }, { from: "#000000", to: "#00FF00" }], 100).data)).toEqual(blue);
        expect(recolorPixels(pixels([250, 0, 0, 255]), [{ from: "#FF0000", to: "#0000FF" }], 0).changedPixels).toBe(0);
        expect(() => recolorPixels(pixels(red), [], 0)).toThrow();
        expect(() => recolorPixels(pixels(red), [{ from: "#FF0000", to: "#0000FF" }], 101)).toThrow();
        expect(() => hexRgb("red")).toThrow(); expect(hexRgb("#00aaff")).toEqual([0, 170, 255]);
        expect(suggestPalette(pixels(red, red, blue, [0, 255, 0, 0]))).toEqual(["#FF0000", "#0000FF"]);
    });
    test("transparent pixels become white for tracing", () => {
        expect(Array.from(lineArtPixels(pixels([0, 0, 0, 0], [0, 0, 0, 255]), 160).data)).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    });
});
describe("real SVG tracing", () => {
    test("contains vector paths and no bitmap, script or external data", () => {
        const data = new Uint8ClampedArray(24 * 24 * 4).fill(255);
        for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) if (x < 7 || x > 16 || y < 7 || y > 16) data.set([0, 0, 0, 255], (y * 24 + x) * 4);
        const svg = traceLineArt({ width: 24, height: 24, data }, { threshold: 160, noise: 0, smoothness: 1 });
        expect(svg).toContain('viewBox="0 0 24 24"'); expect(svg).toMatch(/<path\b/);
        expect(svg).toContain('fill="rgb(0,0,0)"'); expect(svg).not.toMatch(/<image|<script|foreignObject|base64|href=/i);
    });
    test("blank input and excessive image size do not produce a misleading SVG", () => {
        expect(() => traceLineArt(pixels([255, 255, 255, 255]), { threshold: 160, noise: 0, smoothness: 1 })).toThrow("未检测到");
        expect(() => traceLineArt({ width: 4096, height: 1, data: new Uint8ClampedArray(4096 * 4) }, { threshold: 160, noise: 0, smoothness: 1 })).toThrow("2048");
    });
});
describe("selection and uncomposited result storage", () => {
    const image: SceneImage = { id: "original", name: "原图.png", width: 20, height: 30, bytes: 10, mimeType: "image/png", type: "image/png", dataUrl: "blob:original", storageKey: "image:original" };
    const selection = { sourceId: image.id, mask: { ...image, id: "mask", storageKey: "image:mask", dataUrl: "blob:mask" } };
    const draft = { images: { primary: image }, selection, form: createSceneForm("local-restyle"), config: { model: "model", imageModel: "model", size: "auto", quality: "auto", count: "1" } };
    test("selection is bound to identity and exact dimensions", () => {
        expect(selectionMatchesSource(selection, image)).toBe(true);
        expect(selectionMatchesSource(selection, { ...image, id: "replacement" })).toBe(false);
        expect(selectionMatchesSource(selection, { ...image, width: 21 })).toBe(false);
        expect(selectionMatchesSource(selection, undefined)).toBe(false);
        expect(serializeSceneDraft(draft).selection).toMatchObject({ sourceId: "original", mask: { storageKey: "image:mask", dataUrl: "" } });
    });
    test("failed composite retains raw generated image in durable history without counting success", () => {
        const log: SceneLog = { ...draft, id: "log", sceneId: "local-restyle", ownerId: "owner", prompt: "修改", createdAt: 1, referenceImages: draft.images, images: [], results: [{ id: "result", status: "failed", uncompositedImage: image, error: "比例不一致" }], durationMs: 1, successCount: 0, failCount: 1 };
        const stored = serializeSceneLog(log);
        expect(stored.results[0]?.uncompositedImage).toMatchObject({ storageKey: "image:original", dataUrl: "" });
        expect(stored.selection?.mask.storageKey).toBe("image:mask");
        expect(stored.successCount).toBe(0); expect(JSON.stringify(stored)).not.toContain("blob:");
    });
});
