import { expect, test } from "bun:test";
import { editorRectangleMove, editorRectangles, type ImageEditorOperation } from "@/lib/canvas/image-editor-document";
const rectangle: ImageEditorOperation = { kind: "rectangle", start: { x: 20, y: 30 }, end: { x: 80, y: 60 }, color: "red", width: 3 };
const size = { width: 400, height: 240 };
test("moving a rectangle keeps its dimensions and undo restores its original position", () => {
    const ops = [rectangle, editorRectangleMove([rectangle], 0, { x: 100, y: 50 }, size)];
    expect(editorRectangles(ops, size)[0]).toEqual({ index: 0, x: 120, y: 80, width: 60, height: 30 });
    expect(editorRectangles(ops.slice(0, 1), size)[0].x).toBe(20);
    expect(editorRectangles([...ops, editorRectangleMove(ops, 0, { x: -10, y: 0 }, size)], size)[0].x).toBe(110);
});
test("dragging after crop and rotation uses the current displayed coordinates", () => {
    const ops: ImageEditorOperation[] = [rectangle, { kind: "crop", rect: { x: 10, y: 10, width: 200, height: 100 } }, { kind: "rotate" }];
    const before = editorRectangles(ops, size)[0];
    const moved = editorRectangles([...ops, editorRectangleMove(ops, 0, { x: 10, y: 20 }, size)], size)[0];
    expect(moved).toEqual({ ...before, x: before.x + 10, y: before.y + 20 });
});
