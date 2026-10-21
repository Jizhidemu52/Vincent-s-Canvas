import { describe, expect, test } from "bun:test";
import { defaultVectorOptions, executeVectorTrace, tracePattern, validateVectorOptions } from "@/pages/creative/pattern-trace";
import { traceLineArt } from "@/pages/creative/line-trace";
import type { PixelImage } from "@/pages/creative/image-processing";

function artwork(): PixelImage {
    const image = { width: 48, height: 40, data: new Uint8ClampedArray(48 * 40 * 4) };
    for (let y = 4; y < 36; y++) for (let x = 4; x < 44; x++) {
        if (x >= 16 && x < 24 && y >= 12 && y < 28) continue;
        image.data.set(x < 28 ? [220, 40, 60, 255] : [20, 90, 180, 255], (y * image.width + x) * 4);
    }
    return image;
}

describe("color pattern vectorization", () => {
    test("uses real paths, preserves visible colors and transparent holes, and is deterministic", () => {
        const image = artwork(), before = new Uint8ClampedArray(image.data);
        const options = { colors: 2, noise: 0, smoothness: .1 };
        const result = tracePattern(image, options);
        expect(result.palette).toEqual(expect.arrayContaining([{ r: 220, g: 40, b: 60, a: 255 }, { r: 20, g: 90, b: 180, a: 255 }]));
        expect(result.palette).toHaveLength(2);
        expect(result.transparentPixels).toBe(768);
        expect(result.svg).toContain('viewBox="0 0 48 40"');
        expect(result.svg).toContain('fill="rgb(220,40,60)"');
        expect(result.svg).toContain('fill="rgb(20,90,180)"');
        expect(result.svg).toContain('opacity="0"');
        expect(result.pathCount).toBeGreaterThanOrEqual(2);
        expect(result.svg).not.toMatch(/<image|<script|foreignObject|href=|base64/i);
        expect(tracePattern(image, options).svg).toBe(result.svg);
        expect(image.data).toEqual(before);
    });
    test("hidden RGB in fully transparent pixels cannot alter palette or foreground", () => {
        const original = artwork(), changed = artwork();
        for (let at = 0; at < changed.data.length; at += 4) if (!changed.data[at + 3]) changed.data.set([255, 0, 255], at);
        const options = { colors: 2, noise: 0, smoothness: .1 };
        expect(tracePattern(original, options).svg).toBe(tracePattern(changed, options).svg);
    });
    test("accepts browser ImageData dimensions exposed through prototype getters", () => {
        const plain = artwork();
        const nativeShape = Object.create({ get width() { return plain.width; }, get height() { return plain.height; }, get data() { return plain.data; } }) as PixelImage;
        const options = { colors: 2, noise: 0, smoothness: .1 };
        expect(Object.keys(nativeShape)).toHaveLength(0);
        expect(tracePattern(nativeShape, options).svg).toBe(tracePattern(plain, options).svg);
    });
    test("uniform semitransparent artwork stays translucent, with a clear background", () => {
        const image = artwork();
        for (let at = 0; at < image.data.length; at += 4) if (image.data[at + 3]) image.data.set([30, 80, 150, 128], at);
        const result = tracePattern(image, { colors: 4, noise: 0, smoothness: .1 });
        expect(result.palette).toEqual([{ r: 30, g: 80, b: 150, a: 128 }]);
        expect(result.partialAlphaPixels).toBe(1152);
        expect(result.svg).toContain('opacity="0.5019607843137255"');
    });
    test("rejects empty, unsupported, oversize or malformed inputs before tracing", () => {
        const options = defaultVectorOptions("pattern");
        expect(() => tracePattern({ width: 8, height: 8, data: new Uint8ClampedArray(256) }, options)).toThrow("完全透明");
        expect(() => tracePattern({ width: 2049, height: 1, data: new Uint8ClampedArray(2049 * 4) }, options)).toThrow("2048");
        expect(() => tracePattern({ ...artwork(), data: new Uint8ClampedArray(2) }, options)).toThrow("像素数据");
        for (const patch of [{ colors: 1 }, { colors: 33 }, { colors: 3.2 }, { noise: -1 }, { smoothness: 0 }, { threshold: 255 }, { transparentBackground: undefined }]) {
            expect(() => validateVectorOptions({ ...options, ...patch })).toThrow();
        }
        expect(() => executeVectorTrace({ mode: "unsupported" as "pattern", image: artwork(), options })).toThrow("不支持");
    });
});

describe("transparent line-art vectors", () => {
    test("optional transparent paper changes background opacity and keeps the input immutable", () => {
        const image = artwork();
        const before = new Uint8ClampedArray(image.data);
        const options = { threshold: 160, noise: 0, smoothness: .1 };
        const opaque = traceLineArt(image, options);
        const transparent = traceLineArt(image, { ...options, transparentBackground: true });
        expect(opaque).toMatch(/fill="rgb\(255,255,255\)"[^>]*opacity="1"/);
        expect(transparent).toMatch(/fill="rgb\(255,255,255\)"[^>]*opacity="0"/);
        expect(transparent).toMatch(/fill="rgb\(0,0,0\)"[^>]*opacity="1"/);
        expect(image.data).toEqual(before);
    });
    test("the independent sketch task returns paths and rejects a blank line drawing", () => {
        const result = executeVectorTrace({ mode: "sketch", image: artwork(), options: defaultVectorOptions("sketch") });
        expect(result.pathCount).toBeGreaterThan(0);
        expect(result.palette).toEqual([{ r: 0, g: 0, b: 0, a: 255 }]);
        expect(result.svg).not.toMatch(/<image|href=/i);
        expect(() => executeVectorTrace({ mode: "sketch", image: { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) }, options: defaultVectorOptions("sketch") })).toThrow("未检测到");
    });
});
