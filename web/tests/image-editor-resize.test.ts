import { expect, test } from "bun:test";
import { editorDocumentSize, editorRectangleMove, editorRectangles, editorResizeGeometry, editorSizeError, type ImageEditorOperation } from "@/lib/canvas/image-editor-document";

test("custom 728 x 90 pixels participates in crop/rotate ordering and undo replay", () => {
    const original = { width: 800, height: 400 };
    const operations = [
        { kind: "crop", rect: { x: 10, y: 10, width: 200, height: 100 } },
        { kind: "resize", width: 728, height: 90, mode: "contain" },
        { kind: "rotate" },
    ] as ImageEditorOperation[];
    expect(editorDocumentSize(original, operations.slice(0, 2))).toEqual({ width: 728, height: 90 });
    expect(editorDocumentSize(original, operations)).toEqual({ width: 90, height: 728 });
    expect(editorDocumentSize(original, operations.slice(0, 1))).toEqual({ width: 200, height: 100 });
    expect(editorDocumentSize(original, [])).toEqual({ width: 800, height: 400 });
    expect(original).toEqual({ width: 800, height: 400 });
});

test("contain defaults to preserving the entire source with centered padding for banner dimensions", () => {
    expect(editorResizeGeometry({ width: 800, height: 400 }, { width: 728, height: 90 })).toEqual({
        x: 274, y: 0, width: 180, height: 90, scaleX: .225, scaleY: .225,
    });
});

test("cover fills the target with centered crop and stretch changes the two axes explicitly", () => {
    expect(editorResizeGeometry({ width: 800, height: 400 }, { width: 728, height: 90 }, "cover")).toEqual({
        x: 0, y: -137, width: 728, height: 364, scaleX: .91, scaleY: .91,
    });
    expect(editorResizeGeometry({ width: 800, height: 400 }, { width: 728, height: 90 }, "stretch")).toEqual({
        x: 0, y: 0, width: 728, height: 90, scaleX: .91, scaleY: .225,
    });
    expect(editorResizeGeometry({ width: 400, height: 800 }, { width: 90, height: 728 })).toEqual({
        x: 0, y: 274, width: 90, height: 180, scaleX: .225, scaleY: .225,
    });
});

test("dimensions accept positive integers at the edge and reject unsafe dimensions before allocation", () => {
    for (const target of [{ width: 1, height: 1 }, { width: 8192, height: 1 }, { width: 5000, height: 5000 }]) {
        expect(editorSizeError(target)).toBe("");
        expect(editorDocumentSize({ width: 800, height: 400 }, [{ kind: "resize", ...target, mode: "contain" }])).toEqual(target);
    }
    for (const target of [
        { width: 0, height: 90 }, { width: 728, height: -1 }, { width: 728.5, height: 90 }, { width: NaN, height: 90 },
        { width: Infinity, height: 90 }, { width: 8193, height: 1 }, { width: 1, height: 8193 }, { width: 5001, height: 5000 },
    ]) {
        expect(editorSizeError(target)).not.toBe("");
        expect(() => editorResizeGeometry({ width: 800, height: 400 }, target)).toThrow();
        expect(() => editorDocumentSize({ width: 800, height: 400 }, [{ kind: "resize", ...target, mode: "contain" }])).toThrow();
    }
});

test("rectangle hit bounds follow contain padding while new marks use resized pixel coordinates", () => {
    const original = { width: 400, height: 240 };
    const rectangle: ImageEditorOperation = { kind: "rectangle", start: { x: 20, y: 30 }, end: { x: 80, y: 60 }, color: "red", width: 3 };
    const operations: ImageEditorOperation[] = [rectangle, { kind: "resize", width: 728, height: 90, mode: "contain" }, rectangle];
    expect(editorRectangles(operations, original)).toEqual([
        { index: 0, x: 296.5, y: 11.25, width: 22.5, height: 11.25 },
        { index: 2, x: 20, y: 30, width: 60, height: 30 },
    ]);
    const move = editorRectangleMove(operations, 0, { x: 15, y: 7.5 }, original);
    expect(move).toEqual({ kind: "move-rectangle", index: 0, dx: 40, dy: 20 });
    expect(editorRectangles([...operations, move], original)[0]).toEqual({ index: 0, x: 311.5, y: 18.75, width: 22.5, height: 11.25 });
});

test("drag inversion reverses stretch and rotation order and undo retains the earlier position", () => {
    const original = { width: 400, height: 240 };
    const operations: ImageEditorOperation[] = [
        { kind: "rectangle", start: { x: 20, y: 30 }, end: { x: 80, y: 60 }, color: "red", width: 3 },
        { kind: "resize", width: 800, height: 120, mode: "stretch" },
        { kind: "rotate" },
        { kind: "resize", width: 600, height: 200, mode: "stretch" },
    ];
    expect(editorRectangles(operations, original)[0]).toEqual({ index: 0, x: 450, y: 10, width: 75, height: 30 });
    const move = editorRectangleMove(operations, 0, { x: 20, y: 15 }, original);
    expect(move).toEqual({ kind: "move-rectangle", index: 0, dx: 30, dy: -8 });
    expect(editorRectangles([...operations, move], original)[0]).toEqual({ index: 0, x: 470, y: 25, width: 75, height: 30 });
    expect(editorRectangles(operations, original)[0]).toEqual({ index: 0, x: 450, y: 10, width: 75, height: 30 });
});

test("crop after cover uses cropped coordinates for hit bounds and later resize scale", () => {
    const original = { width: 400, height: 200 };
    const operations: ImageEditorOperation[] = [
        { kind: "rectangle", start: { x: 100, y: 50 }, end: { x: 200, y: 100 }, color: "red", width: 3 },
        { kind: "resize", width: 200, height: 200, mode: "cover" },
        { kind: "crop", rect: { x: 0, y: 40, width: 100, height: 80 } },
        { kind: "resize", width: 200, height: 160, mode: "contain" },
    ];
    expect(editorRectangles(operations, original)[0]).toEqual({ index: 0, x: 0, y: 20, width: 200, height: 100 });
    expect(editorRectangleMove(operations, 0, { x: 10, y: 20 }, original)).toEqual({ kind: "move-rectangle", index: 0, dx: 5, dy: 10 });
    expect(editorDocumentSize(original, operations)).toEqual({ width: 200, height: 160 });
});
