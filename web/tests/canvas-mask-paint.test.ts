import { expect, test } from "bun:test";
import { buildCanvasEditMask, canvasMaskBrushPixels, canvasMaskPoint, canvasMaskPreviewSize, renderMaskPreview } from "@/lib/canvas/canvas-mask-paint";

test("preview work is bounded while pointer positions and brush diameter use original pixels", () => {
    const source = { width: 6000, height: 4000 };
    const rect = { width: 600, height: 400, left: 20, top: 30 };
    expect(canvasMaskPreviewSize(source)).toEqual({ width: 1200, height: 800 });
    expect(canvasMaskPreviewSize({ width: 800, height: 1200 })).toEqual({ width: 800, height: 1200 });
    expect(canvasMaskBrushPixels(40, source, rect)).toBe(400);
    expect(canvasMaskPoint(source, rect, 320, 230)).toEqual({ x: 3000, y: 2000 });
    expect(canvasMaskPoint(source, rect, -20, 900)).toEqual({ x: 0, y: 4000 });
});

test("stroke preview never reads full source pixels and reads the small overlay only at stroke end", () => {
    const reads: number[][] = [];
    const draws: unknown[][] = [];
    const source = { width: 6000, height: 4000, getContext: () => { throw new Error("Unexpected full source read"); } } as unknown as HTMLCanvasElement;
    const context = {
        clearRect() {}, fillRect() {}, save() {}, restore() {},
        drawImage: (...args: unknown[]) => draws.push(args),
        getImageData: (...args: number[]) => { reads.push(args); return { data: new Uint8ClampedArray(1200 * 800 * 4) }; },
    };
    const preview = { width: 1200, height: 800, getContext: () => context } as unknown as HTMLCanvasElement;
    renderMaskPreview(source, preview);
    expect(reads).toEqual([]);
    renderMaskPreview(source, preview, true);
    expect(reads).toEqual([[0, 0, 1200, 800]]);
    expect(draws).toEqual([[source, 0, 0, 1200, 800], [source, 0, 0, 1200, 800]]);
});

test("export reads the source once, preserves exact dimensions and binary edit alpha, rejects an empty mask", () => {
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const input = new Uint8ClampedArray(3 * 2 * 4);
    input[3] = 1; input[7] = 255; input[23] = 120;
    let sourceReads = 0, written: Uint8ClampedArray | undefined, encoded = 0;
    const output = {
        width: 0, height: 0,
        getContext: () => ({
            createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
            putImageData: (value: { data: Uint8ClampedArray }) => { written = value.data; },
        }),
        toDataURL: (mime: string) => { encoded++; expect(mime).toBe("image/png"); return "data:image/png;base64,mask"; },
    };
    const source = { width: 3, height: 2, getContext: () => ({ getImageData: () => { sourceReads++; return { data: input }; } }) } as unknown as HTMLCanvasElement;
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => output } });
    try {
        expect(buildCanvasEditMask(source)).toBe("data:image/png;base64,mask");
        expect(sourceReads).toBe(1);
        expect([output.width, output.height]).toEqual([3, 2]);
        expect(Array.from(written!).filter((_value, index) => index % 4 === 3)).toEqual([0, 0, 255, 255, 255, 0]);
        expect(Array.from(written!).filter((_value, index) => index % 4 !== 3).every(value => value === 255)).toBe(true);
        input.fill(0);
        expect(() => buildCanvasEditMask(source)).toThrow("请先涂抹");
        expect(encoded).toBe(1);
    } finally {
        if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
        else Reflect.deleteProperty(globalThis, "document");
    }
});
