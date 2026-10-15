import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { movePhotoSamplePoint, photoPixelHex, photoSamplePoint, PhotoColorSampler } from "@/pages/creative/photo-color-sampler";
import { loadProcessingImage } from "@/pages/creative/image-processing-browser";

describe("garment photo color sampling", () => {
    test("maps a scaled image with an offset back to decoded canvas pixels", () => {
        const bounds = { left: 51, top: 24, width: 90, height: 180 };
        const size = { width: 1000, height: 2000 };
        expect(photoSamplePoint({ x: 96, y: 114 }, bounds, size)).toEqual({ x: 500, y: 1000 });
        expect(photoSamplePoint({ x: 51, y: 24 }, bounds, size)).toEqual({ x: 0, y: 0 });
        expect(photoSamplePoint({ x: 141, y: 204 }, bounds, size)).toEqual({ x: 999, y: 1999 });
        expect(photoSamplePoint({ x: 0, y: 0 }, bounds, size)).toEqual({ x: 0, y: 0 });
        expect(photoSamplePoint({ x: 1, y: 1 }, { ...bounds, width: 0 }, size)).toBeNull();
    });

    test("a 48 MP photo is reduced before enforcing editor canvas limits", async () => {
        const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Image");
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
        const draws: unknown[][] = [];
        const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }) };
        class LargePhoto {
            naturalWidth = 8000;
            naturalHeight = 6000;
            onload?: () => void;
            set src(_value: string) { queueMicrotask(() => this.onload?.()); }
        }
        Object.defineProperty(globalThis, "Image", { configurable: true, value: LargePhoto });
        Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => canvas } });
        try {
            const result = await loadProcessingImage("data:image/jpeg;base64,large-photo", 2048);
            expect([result.width, result.height]).toEqual([2048, 1536]);
            expect(draws).toHaveLength(1);
            expect(draws[0].slice(1)).toEqual([0, 0, 2048, 1536]);
        } finally {
            if (imageDescriptor) Object.defineProperty(globalThis, "Image", imageDescriptor);
            else Reflect.deleteProperty(globalThis, "Image");
            if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
            else Reflect.deleteProperty(globalThis, "document");
        }
    });

    test("keyboard movement stays in bounds and supports single-pixel precision", () => {
        const size = { width: 1000, height: 2000 };
        expect(movePhotoSamplePoint({ x: 500, y: 1000 }, size, "ArrowRight")).toEqual({ x: 510, y: 1000 });
        expect(movePhotoSamplePoint({ x: 500, y: 1000 }, size, "ArrowUp")).toEqual({ x: 500, y: 980 });
        expect(movePhotoSamplePoint({ x: 500, y: 1000 }, size, "ArrowLeft", true)).toEqual({ x: 499, y: 1000 });
        expect(movePhotoSamplePoint({ x: 0, y: 0 }, size, "ArrowUp")).toEqual({ x: 0, y: 0 });
        expect(movePhotoSamplePoint({ x: 999, y: 1999 }, size, "ArrowDown")).toEqual({ x: 999, y: 1999 });
    });

    test("uses RGB values without sampling fully transparent pixels", () => {
        expect(photoPixelHex(new Uint8ClampedArray([5, 170, 255, 255]))).toBe("#05AAFF");
        expect(photoPixelHex(new Uint8ClampedArray([5, 170, 255, 0]))).toBeNull();
        expect(photoPixelHex(new Uint8ClampedArray())).toBeNull();
    });

    test("exposes loading feedback and instructions before local image decoding", () => {
        const markup = renderToStaticMarkup(<PhotoColorSampler src="data:image/png;base64,test" onPick={() => { throw new Error("Rendering must not pick a color"); }} />);
        expect(markup).toContain('aria-busy="true"');
        expect(markup).toContain('role="status"');
        expect(markup).toContain("正在读取照片");
        expect(markup).toContain("Enter 或空格取色");
    });
});
