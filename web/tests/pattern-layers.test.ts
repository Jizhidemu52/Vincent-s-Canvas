import { describe, expect, test } from "bun:test";
import { initializeCanvas, readPsd, writePsd } from "ag-psd";
import { buildLayerMaskPrompt, layerMaskCoverage, partitionPatternLayers, type PatternLayer } from "@/pages/creative/pattern-layers-model";

const source = { width: 3, height: 2, data: new Uint8ClampedArray([
    255,0,0,255, 0,255,0,200, 0,0,255,255,
    40,50,60,255, 90,100,110,120, 140,150,160,0,
]) };
const mask = (indices: number[]) => ({ width: 3, height: 2, data: new Uint8ClampedArray(Array.from({ length: 6 }, (_, i) => indices.includes(i) ? [255,255,255,255] : [0,0,0,255]).flat()) });
const layer = (name: string): PatternLayer => ({ id: name, name, maskUrl: "", maskMode: "luminance", threshold: 128, visible: true, opacity: 1, x: 0, y: 0 });
initializeCanvas(() => { throw new Error("Pixel-only PSD test must not use canvas rendering"); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }));

describe("editable pattern layers", () => {
    test("keeps source colors/alpha and partitions overlapping selections without duplicated pixels", () => {
        const result = partitionPatternLayers(source, [{ layer: layer("red-green"), mask: mask([0, 1]) }, { layer: layer("green"), mask: mask([1, 4]) }]);
        expect(result[1]!.image.width).toBe(1);
        expect([...result[1]!.image.data]).toEqual([255, 0, 0, 255]);
        expect(result[2]!.left).toBe(1);
        expect([...result[2]!.image.data]).toEqual([0, 255, 0, 200, 90, 100, 110, 120]);
        const rebuilt = new Uint8ClampedArray(source.data.length);
        for (const item of result) for (let y = 0; y < item.image.height; y++) for (let x = 0; x < item.image.width; x++) {
            const offset = (y * item.image.width + x) * 4;
            if (!item.image.data[offset + 3]) continue;
            rebuilt.set(item.image.data.subarray(offset, offset + 4), ((item.top + y) * source.width + item.left + x) * 4);
        }
        for (let i = 0; i < 6; i++) if (source.data[i * 4 + 3]) expect([...rebuilt.subarray(i * 4, i * 4 + 4)]).toEqual([...source.data.subarray(i * 4, i * 4 + 4)]);
    });
    test("interprets painted alpha separately from generated luminance and rejects invalid dimensions", () => {
        const blue = { width: 1, height: 1, data: new Uint8ClampedArray([42,119,246,255]) };
        expect([...layerMaskCoverage(blue, "alpha", 128)]).toEqual([1]);
        expect([...layerMaskCoverage(blue, "luminance", 128)]).toEqual([0]);
        expect(() => partitionPatternLayers(source, [{ layer: layer("bad"), mask: blue }])).toThrow("尺寸");
    });
    test("exports a real multilayer PSD with offsets, transparency and independent pixels that read back", () => {
        const items = partitionPatternLayers(source, [{ layer: { ...layer("绿色"), x: 2, y: -1, opacity: .5, visible: false }, mask: mask([1, 4]) }]);
        const bytes = writePsd({ width: 3, height: 2, children: items.map(item => ({ name: item.name, left: item.left, top: item.top, hidden: !item.visible, opacity: item.opacity, imageData: item.image })) });
        expect(String.fromCharCode(...new Uint8Array(bytes).slice(0, 4))).toBe("8BPS");
        const result = readPsd(bytes, { useImageData: true, skipCompositeImageData: true });
        expect(result.children).toHaveLength(2);
        const green = result.children![1]!;
        expect(green).toMatchObject({ name: "绿色", left: 3, top: -1, hidden: true });
        expect(green.opacity).toBeCloseTo(.5, 2);
        expect([...green.imageData!.data]).toEqual([0,255,0,200,90,100,110,120]);
    });
    test("requires an explicit target and forbids recoloring artwork in the mask task", () => {
        expect(() => buildLayerMaskPrompt(" ")).toThrow();
        expect(buildLayerMaskPrompt("花朵")).toContain("不要输出原图颜色");
    });
});
