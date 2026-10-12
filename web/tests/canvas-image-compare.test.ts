import { describe, expect, test } from "bun:test";
import { CANVAS_DIFFERENCE_MAX_EDGE, CANVAS_DIFFERENCE_MAX_PIXELS, canvasComparePreviewScale, canvasDifferenceLayout, canvasDifferenceNotice, canvasDifferencePixels, drawCanvasCompare } from "@/lib/canvas/canvas-image-compare";

const image = (naturalWidth: number, naturalHeight: number) => ({ naturalWidth, naturalHeight } as HTMLImageElement);

describe("bounded original-pixel difference layout", () => {
    test("equal normal-sized sources keep exact decoded pixels", () => {
        expect(canvasDifferenceLayout(image(640, 480), image(640, 480))).toEqual({ width: 640, height: 480, sameSize: true, downsampled: false, pixelExact: true });
    });
    test("different dimensions never claim pixel-exact equality", () => {
        const layout = canvasDifferenceLayout(image(640, 480), image(320, 320));
        expect(layout.pixelExact).toBe(false); expect(layout.sameSize).toBe(false);
        expect(canvasDifferenceNotice(layout)).toContain("非原像素");
        expect(canvasDifferenceNotice(layout)).toContain("按比例居中");
    });
    test("both area and long edge stay bounded, including thin images", () => {
        for (const source of [image(4000, 4000), image(4097, 1), image(1, 99999), image(4097, 1024)]) {
            const layout = canvasDifferenceLayout(source, source);
            expect(layout.width * layout.height).toBeLessThanOrEqual(CANVAS_DIFFERENCE_MAX_PIXELS);
            expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(CANVAS_DIFFERENCE_MAX_EDGE);
            expect(Math.min(layout.width, layout.height)).toBeGreaterThanOrEqual(1);
            expect(layout.downsampled).toBe(true); expect(layout.pixelExact).toBe(false);
            expect(canvasDifferenceNotice(layout)).toContain("已降采样");
        }
    });
    test("exact cap is allowed, invalid source sizes reject before allocating", () => {
        expect(canvasDifferenceLayout(image(2000, 2000), image(2000, 2000)).pixelExact).toBe(true);
        for (const width of [0, -1, NaN, Infinity, 1.5]) expect(() => canvasDifferenceLayout(image(width, 1), image(1, 1))).toThrow("尺寸无效");
    });
});

describe("premultiplied RGBA difference", () => {
    test("identical pixels produce opaque black without mutating inputs", () => {
        const input = new Uint8ClampedArray([42, 12, 90, 255, 192, 120, 100, 64]), snapshot = input.slice();
        expect([...canvasDifferencePixels(input, input)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]); expect(input).toEqual(snapshot);
    });
    test("localized changes retain their exact positions", () => {
        const a = new Uint8ClampedArray(5 * 4); for (let i = 3; i < a.length; i += 4) a[i] = 255;
        const b = a.slice(); b[8] = 91;
        expect([...canvasDifferencePixels(a, b)]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 91, 91, 91, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    });
    test("fully transparent hidden colors are ignored", () => {
        expect([...canvasDifferencePixels(new Uint8ClampedArray([255, 33, 22, 0]), new Uint8ClampedArray([0, 244, 99, 0]))]).toEqual([0, 0, 0, 255]);
    });
    test("alpha changes remain visible even if both RGB are black", () => {
        expect([...canvasDifferencePixels(new Uint8ClampedArray([0, 0, 0, 0]), new Uint8ClampedArray([0, 0, 0, 128]))]).toEqual([128, 128, 128, 255]);
    });
    test("RGB differences use premultiplied alpha and are symmetric", () => {
        const a = new Uint8ClampedArray([255, 0, 0, 128]), b = new Uint8ClampedArray([0, 0, 0, 128]);
        expect([...canvasDifferencePixels(a, b)]).toEqual([128, 128, 128, 255]); expect(canvasDifferencePixels(a, b)).toEqual(canvasDifferencePixels(b, a));
    });
    test("invalid buffers and over-cap allocations reject", () => {
        expect(() => canvasDifferencePixels(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toThrow("尺寸不一致");
        expect(() => canvasDifferencePixels(new Uint8ClampedArray(3), new Uint8ClampedArray(3))).toThrow("尺寸不一致");
        const large = new Uint8ClampedArray((CANVAS_DIFFERENCE_MAX_PIXELS + 1) * 4);
        expect(() => canvasDifferencePixels(large, large)).toThrow("上限");
    });
});

test("fit uses both viewport dimensions; 1x/2x/4x are CSS output-pixel scales", () => {
    expect(canvasComparePreviewScale(1000, 1048, 350, 300, "fit")).toBeCloseTo(300 / 1048);
    expect(canvasComparePreviewScale(100, 100, 350, 300, "fit")).toBe(1);
    for (const zoom of [1, 2, 4] as const) expect(canvasComparePreviewScale(1000, 1048, 350, 300, zoom)).toBe(zoom);
});

test("difference renderer reads separate transparent surfaces and writes opaque grayscale without a header", () => {
    const inputs = [new Uint8ClampedArray([255, 0, 0, 0, 100, 90, 50, 255]), new Uint8ClampedArray([0, 255, 0, 0, 150, 90, 50, 255])];
    let reads = 0; const clears: number[][] = [], draws: number[][] = []; let output: Uint8ClampedArray | undefined;
    const context = {
        clearRect: (...args: number[]) => clears.push(args),
        drawImage: (_image: unknown, ...args: number[]) => draws.push(args),
        getImageData: () => ({ data: inputs[reads++].slice() }),
        putImageData: (data: { data: Uint8ClampedArray }) => { output = data.data.slice(); },
    };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    drawCanvasCompare(canvas, image(2, 1), image(2, 1), "difference", 17, "#fff", "#000");
    expect([canvas.width, canvas.height]).toEqual([2, 1]);
    expect(clears).toEqual([[0, 0, 2, 1], [0, 0, 2, 1]]); expect(draws).toEqual([[0, 0, 2, 1], [0, 0, 2, 1]]);
    expect([...(output || [])]).toEqual([0, 0, 0, 255, 50, 50, 50, 255]);
    expect([...inputs[0]]).toEqual([255, 0, 0, 0, 100, 90, 50, 255]);
});

test("difference read failures are surfaced and existing modes can still draw after recovery", () => {
    let draws = 0;
    const context = { clearRect() {}, drawImage() { draws++; }, getImageData() { throw new DOMException("Cross-origin", "SecurityError"); }, fillRect() {}, save() {}, restore() {}, fillText() {} };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    expect(() => drawCanvasCompare(canvas, image(2, 1), image(2, 1), "difference", 50, "#fff", "#000")).toThrow("Cross-origin");
    drawCanvasCompare(canvas, image(2, 1), image(2, 1), "side", 50, "#fff", "#000");
    expect([canvas.width, canvas.height]).toEqual([1600, 1048]); expect(draws).toBe(3);
});
