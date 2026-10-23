import { expect, test } from "bun:test";
import { fitCropRatio, moveCrop, resizeCrop, type CanvasCropHandle, type CanvasImageCropRect } from "@/lib/canvas/canvas-crop-geometry";

const initial: CanvasImageCropRect = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
const handles: CanvasCropHandle[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
function inBounds(crop: CanvasImageCropRect) {
    expect(crop.x).toBeGreaterThanOrEqual(-1e-10);
    expect(crop.y).toBeGreaterThanOrEqual(-1e-10);
    expect(crop.width).toBeGreaterThan(0);
    expect(crop.height).toBeGreaterThan(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-10);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1 + 1e-10);
}

test("free crop changes one axis independently and keeps the opposite edge anchored", () => {
    const resized = resizeCrop(initial, -0.2, 0, "e", null);
    expect(resized.width).toBeCloseTo(0.56);
    expect(resized.height).toBe(initial.height);
    expect(resized.x).toBe(initial.x);
    const west = resizeCrop(initial, -2, 0, "w", null);
    expect(west.x).toBe(0);
    expect(west.x + west.width).toBeCloseTo(initial.x + initial.width);
    inBounds(west);
});

for (const [width, height] of [[800, 600], [600, 800], [4000, 4]]) {
    for (const pixelRatio of [1, 4 / 3, 3 / 4, 3 / 2, 2 / 3, 16 / 9, 9 / 16, width! / height!]) {
        test(`preset ${pixelRatio} retains its pixel ratio on ${width}x${height} through all edge and corner limits`, () => {
            const ratio = pixelRatio / (width! / height!);
            const crop = fitCropRatio(initial, ratio);
            expect(crop.width * width! / (crop.height * height!)).toBeCloseTo(pixelRatio, 8);
            inBounds(crop);
            for (const handle of handles) for (const [dx, dy] of [[-3, -3], [3, 3], [0.1, -0.15], [-0.1, 0.15]]) {
                const resized = resizeCrop(crop, dx!, dy!, handle, ratio);
                inBounds(resized);
                expect(resized.width * width! / (resized.height * height!)).toBeCloseTo(pixelRatio, 8);
                inBounds(resizeCrop(resized, dx!, dy!, handle, null));
            }
        });
    }
}

test("moving a crop does not alter its dimensions or mutate the original selection", () => {
    const original = { ...initial };
    const result = moveCrop(original, -2, 2);
    expect(result).toEqual({ ...initial, x: 0, y: 1 - initial.height });
    expect(original).toEqual(initial);
});
