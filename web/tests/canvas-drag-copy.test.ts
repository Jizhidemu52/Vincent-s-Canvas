import { describe, expect, test } from "bun:test";
import { canvasRepeatCopyOffset, exceedsCanvasDragThreshold, removeCanvasDragCopies } from "@/lib/canvas/canvas-drag-copy";

describe("Alt drag transaction boundaries", () => {
    test("creation starts strictly after three screen pixels, including diagonal motion", () => {
        expect(exceedsCanvasDragThreshold(10, 10, 10, 10)).toBe(false);
        expect(exceedsCanvasDragThreshold(10, 10, 13, 10)).toBe(false);
        expect(exceedsCanvasDragThreshold(10, 10, 13.01, 10)).toBe(true);
        expect(exceedsCanvasDragThreshold(10, 10, 12.2, 12.2)).toBe(true);
    });
    test("repeat offset only follows the same copied selection, independent of selection ordering", () => {
        const previous = { selectedIds: new Set(["a", "b"]), offset: { x: 210, y: -70 } };
        expect(canvasRepeatCopyOffset(previous, new Set(["b", "a"]))).toEqual(previous.offset);
        expect(canvasRepeatCopyOffset(previous, new Set(["a"]))).toEqual({ x: 36, y: 36 });
        expect(canvasRepeatCopyOffset(previous, new Set(["other"]))).toEqual({ x: 36, y: 36 });
        expect(canvasRepeatCopyOffset(null, new Set(["a", "b"]))).toEqual({ x: 36, y: 36 });
    });
    test("cancel preserves the original array identity but keeps concurrent unrelated updates", () => {
        const before = [{ id: "a", value: "original" }], copy = { id: "copy", value: "original" };
        const ids = new Set([copy.id]);
        expect(removeCanvasDragCopies([...before, copy], ids, before)).toBe(before);
        const updated = { id: "a", value: "completed generation" }, unrelated = { id: "other", value: "new" };
        expect(removeCanvasDragCopies([updated, copy, unrelated], ids, before)).toEqual([updated, unrelated]);
    });
});
